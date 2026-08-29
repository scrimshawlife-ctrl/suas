/**
 * D-007 365-day retention dry-run evaluation.
 *
 * This module only evaluates a supplied, non-identifying candidate. It never
 * selects rows, performs a deletion, or treats eligibility as authorization.
 */

export const RETENTION_WINDOW_DAYS = 365 as const;
export const RETENTION_DRY_RUN_ACTION = 'MANUAL_REVIEW_REQUIRED' as const;

export const RETENTION_EXCLUSIONS = [
  'OPEN_CASE',
  'LEGAL_HOLD',
  'UNRESOLVED_SAFETY_OR_SECURITY_INCIDENT',
  'ACTIVE_PROVIDER_OR_PAYMENT_DISPUTE',
  'INCOMPLETE_EXPORT_OR_DELETION_REQUEST',
  'STATUTORY_RETENTION_OBLIGATION',
] as const;
export type RetentionExclusion = (typeof RETENTION_EXCLUSIONS)[number];

export interface RetentionDryRunCandidate {
  readonly caseClosedAt: Date | null;
  readonly lastParticipantActivityAt: Date | null;
  readonly exclusions: readonly RetentionExclusion[];
}

export interface RetentionDryRunEvaluation {
  readonly action: typeof RETENTION_DRY_RUN_ACTION;
  readonly eligible: boolean;
  readonly eligibleAfter: Date | null;
  readonly reasons: readonly string[];
}

/**
 * Evidence suitable for a D-007 dry-run record. It intentionally contains no
 * candidate identifiers, dates, free text, or any signal that can be used to
 * reconstruct an individual retention decision.
 */
export interface RetentionDryRunSummary {
  readonly action: typeof RETENTION_DRY_RUN_ACTION;
  readonly asOf: Date;
  readonly candidateCount: number;
  readonly eligibleForManualReviewCount: number;
  readonly excludedOrNotYetEligibleCount: number;
  readonly reasonCounts: Readonly<Record<string, number>>;
}

function latestRelevantDate(candidate: RetentionDryRunCandidate): Date | null {
  const dates = [candidate.caseClosedAt, candidate.lastParticipantActivityAt].filter(
    (value): value is Date => value !== null,
  );
  if (dates.some((value) => Number.isNaN(value.getTime()))) {
    throw new Error('D-007 dry-run input includes an invalid date.');
  }
  return dates.length === 0 ? null : new Date(Math.max(...dates.map((value) => value.getTime())));
}

function addCalendarDays(from: Date, days: number): Date {
  const result = new Date(from);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Evaluates the approved policy: 365 days after the later of case closure and
 * last participant activity, subject to documented exclusions. Exact boundary
 * time is eligible. The result still requires manual review.
 */
export function evaluateRetentionDryRun(
  candidate: RetentionDryRunCandidate,
  asOf: Date,
): RetentionDryRunEvaluation {
  if (Number.isNaN(asOf.getTime())) throw new Error('D-007 dry-run requires a valid as-of date.');
  const latest = latestRelevantDate(candidate);
  if (latest === null) {
    return {
      action: RETENTION_DRY_RUN_ACTION,
      eligible: false,
      eligibleAfter: null,
      reasons: ['MISSING_CASE_CLOSURE_OR_PARTICIPANT_ACTIVITY'],
    };
  }

  const eligibleAfter = addCalendarDays(latest, RETENTION_WINDOW_DAYS);
  const reasons = [
    ...(asOf.getTime() < eligibleAfter.getTime() ? ['RETENTION_WINDOW_NOT_ELAPSED'] : []),
    ...candidate.exclusions,
  ];
  return {
    action: RETENTION_DRY_RUN_ACTION,
    eligible: reasons.length === 0,
    eligibleAfter,
    reasons,
  };
}

/**
 * Produces an aggregate-only record for an authorized dry-run. This does not
 * select records, record an operational decision, or authorize a purge.
 */
export function summarizeRetentionDryRun(
  candidates: readonly RetentionDryRunCandidate[],
  asOf: Date,
): RetentionDryRunSummary {
  const reasonCounts = new Map<string, number>();
  let eligibleForManualReviewCount = 0;

  for (const candidate of candidates) {
    const evaluation = evaluateRetentionDryRun(candidate, asOf);
    if (evaluation.eligible) eligibleForManualReviewCount += 1;
    for (const reason of evaluation.reasons) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }

  return {
    action: RETENTION_DRY_RUN_ACTION,
    asOf: new Date(asOf),
    candidateCount: candidates.length,
    eligibleForManualReviewCount,
    excludedOrNotYetEligibleCount: candidates.length - eligibleForManualReviewCount,
    reasonCounts: Object.fromEntries(
      [...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}
