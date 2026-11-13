/**
 * Aggregate reporting projection with no runtime caller; reporting stays disabled.
 * D-025 is not released, and ANALYTICS.md allows no canonical small-cell number before it is.
 * Inputs are pre-coarsened; no database, network, export, or logging effect.
 */
import { z } from 'zod';

export const REPORTING_RELEASE_STATE = 'IMPLEMENTED_DISABLED_PENDING_EVIDENCE' as const;
export const REPORTING_AUDIENCES = ['INTERNAL', 'PARTNER', 'PUBLIC'] as const;
export type ReportingAudience = (typeof REPORTING_AUDIENCES)[number];
/** Test values from a suas-local packet, not policy. Do not cite them as released k thresholds. */
export const PLACEHOLDER_REPORTING_MINIMUM_K: Readonly<Record<ReportingAudience, number>> = {
  INTERNAL: 10,
  PARTNER: 20,
  PUBLIC: 20,
};

const eventSchema = z
  .object({
    period: z.string().regex(/^\d{4}-(?:\d{2}|W\d{2})$/),
    geographyLevel: z.enum(['COUNTY', 'REGION', 'STATE']),
    geographyCode: z.string().min(1).max(120),
    resourceCategory: z.enum(['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT']),
    providerCategory: z.enum(['COMMUNITY', 'GOVERNMENT', 'HEALTHCARE', 'NONPROFIT', 'OTHER']),
    referralSource: z.enum(['SELF', 'STAFF', 'PARTNER', 'PUBLIC_DIRECTORY', 'OTHER']),
    closureReason: z.enum(['COMPLETED', 'UNFULFILLED', 'CANCELLED', 'NO_RESPONSE', 'OTHER']),
    waitTimeBand: z.enum(['UNDER_1_DAY', 'ONE_TO_THREE_DAYS', 'FOUR_TO_SEVEN_DAYS', 'OVER_7_DAYS']),
    outcome: z.enum(['INITIATED', 'COMPLETED', 'UNFULFILLED']),
  })
  .strict();

/** One non-identifying, already-coarsened request outcome. */
export type AggregateReportingEvent = z.infer<typeof eventSchema>;

type ReportingCellKey = Pick<
  AggregateReportingEvent,
  | 'period'
  | 'geographyLevel'
  | 'geographyCode'
  | 'resourceCategory'
  | 'providerCategory'
  | 'referralSource'
  | 'closureReason'
  | 'waitTimeBand'
>;

export interface AggregateReportingCell extends ReportingCellKey {
  readonly requestsInitiated: number | null;
  readonly requestsCompleted: number | null;
  readonly requestsUnfulfilled: number | null;
  readonly completionRatePercent: number | null;
  readonly suppression: 'NONE' | 'PRIMARY_K' | 'COMPLEMENTARY';
}

export interface AggregateReportingProjection {
  readonly audience: ReportingAudience;
  readonly minimumK: number;
  readonly releaseState: typeof REPORTING_RELEASE_STATE;
  readonly fixedDimensions: readonly (keyof ReportingCellKey)[];
  readonly cells: readonly AggregateReportingCell[];
}

const FIXED_DIMENSIONS = [
  'period',
  'geographyLevel',
  'geographyCode',
  'resourceCategory',
  'providerCategory',
  'referralSource',
  'closureReason',
  'waitTimeBand',
] as const satisfies readonly (keyof ReportingCellKey)[];

interface WorkingCell {
  readonly key: ReportingCellKey;
  initiated: number;
  completed: number;
  unfulfilled: number;
  suppression: AggregateReportingCell['suppression'];
}

function keyOf(event: ReportingCellKey): string {
  return FIXED_DIMENSIONS.map((field) => event[field]).join('\u001f');
}

function bucketOf(cell: WorkingCell): string {
  return `${cell.key.period}\u001f${cell.key.geographyLevel}\u001f${cell.key.geographyCode}`;
}

/**
 * Projects the fixed-dimension aggregate only.
 *
 * Primary suppression hides cells below k. If any primary-suppressed cell is
 * present in a period/geography bucket, every otherwise visible cell in that
 * bucket is complementarily suppressed. The report exposes no subtotal or
 * arbitrary filter that could reconstruct either suppressed count.
 */
export function projectAggregateReporting(
  audience: ReportingAudience,
  rawEvents: readonly AggregateReportingEvent[],
): AggregateReportingProjection {
  const minimumK = PLACEHOLDER_REPORTING_MINIMUM_K[audience];
  const cells = new Map<string, WorkingCell>();

  for (const raw of rawEvents) {
    const event = eventSchema.parse(raw);
    const key: ReportingCellKey = {
      period: event.period,
      geographyLevel: event.geographyLevel,
      geographyCode: event.geographyCode,
      resourceCategory: event.resourceCategory,
      providerCategory: event.providerCategory,
      referralSource: event.referralSource,
      closureReason: event.closureReason,
      waitTimeBand: event.waitTimeBand,
    };
    const cellKey = keyOf(key);
    const cell = cells.get(cellKey) ?? {
      key,
      initiated: 0,
      completed: 0,
      unfulfilled: 0,
      suppression: 'NONE' as const,
    };
    cell.initiated += 1;
    if (event.outcome === 'COMPLETED') cell.completed += 1;
    if (event.outcome === 'UNFULFILLED') cell.unfulfilled += 1;
    cells.set(cellKey, cell);
  }

  const byBucket = new Map<string, WorkingCell[]>();
  for (const cell of cells.values()) {
    if (cell.initiated < minimumK) cell.suppression = 'PRIMARY_K';
    const bucket = bucketOf(cell);
    const siblingCells = byBucket.get(bucket) ?? [];
    siblingCells.push(cell);
    byBucket.set(bucket, siblingCells);
  }
  for (const siblingCells of byBucket.values()) {
    if (siblingCells.some((cell) => cell.suppression === 'PRIMARY_K')) {
      for (const cell of siblingCells) {
        if (cell.suppression === 'NONE') cell.suppression = 'COMPLEMENTARY';
      }
    }
  }

  return {
    audience,
    minimumK,
    releaseState: REPORTING_RELEASE_STATE,
    fixedDimensions: FIXED_DIMENSIONS,
    cells: [...cells.values()]
      .sort((a, b) => keyOf(a.key).localeCompare(keyOf(b.key)))
      .map((cell) => {
        if (cell.suppression !== 'NONE') {
          return {
            ...cell.key,
            requestsInitiated: null,
            requestsCompleted: null,
            requestsUnfulfilled: null,
            completionRatePercent: null,
            suppression: cell.suppression,
          };
        }
        return {
          ...cell.key,
          requestsInitiated: cell.initiated,
          requestsCompleted: cell.completed,
          requestsUnfulfilled: cell.unfulfilled,
          completionRatePercent: Math.round((cell.completed / cell.initiated) * 100),
          suppression: 'NONE',
        };
      }),
  };
}
