import { describe, expect, it } from 'vitest';
import {
  projectAggregateReporting,
  PLACEHOLDER_REPORTING_MINIMUM_K,
  REPORTING_RELEASE_STATE,
  type AggregateReportingEvent,
} from '../../src/reporting/index.js';

const BASE_EVENT: AggregateReportingEvent = {
  period: '2026-08',
  geographyLevel: 'COUNTY',
  geographyCode: 'SYNTHETIC-COUNTY',
  resourceCategory: 'FOOD',
  providerCategory: 'NONPROFIT',
  referralSource: 'SELF',
  closureReason: 'COMPLETED',
  waitTimeBand: 'ONE_TO_THREE_DAYS',
  outcome: 'COMPLETED',
};

function events(
  count: number,
  overrides: Partial<AggregateReportingEvent> = {},
): AggregateReportingEvent[] {
  return Array.from({ length: count }, () => ({ ...BASE_EVENT, ...overrides }));
}

describe('aggregate reporting projection (D-025 not released)', () => {
  it('keeps reporting implementation disabled pending release evidence', () => {
    const projection = projectAggregateReporting('INTERNAL', []);
    expect(projection.releaseState).toBe(REPORTING_RELEASE_STATE);
    expect(projection.releaseState).toBe('IMPLEMENTED_DISABLED_PENDING_EVIDENCE');
  });

  it.each([
    ['INTERNAL', 9, 'PRIMARY_K'],
    ['INTERNAL', 10, 'NONE'],
    ['PARTNER', 19, 'PRIMARY_K'],
    ['PARTNER', 20, 'NONE'],
    ['PUBLIC', 19, 'PRIMARY_K'],
    ['PUBLIC', 20, 'NONE'],
  ] as const)('applies the placeholder %s threshold at k=%i', (audience, count, suppression) => {
    const projection = projectAggregateReporting(audience, events(count));
    expect(projection.minimumK).toBe(PLACEHOLDER_REPORTING_MINIMUM_K[audience]);
    expect(projection.cells).toHaveLength(1);
    expect(projection.cells[0]?.suppression).toBe(suppression);
    if (suppression === 'NONE') {
      expect(projection.cells[0]).toMatchObject({
        requestsInitiated: count,
        requestsCompleted: count,
        requestsUnfulfilled: 0,
        completionRatePercent: 100,
      });
    } else {
      expect(projection.cells[0]).toMatchObject({
        requestsInitiated: null,
        requestsCompleted: null,
        requestsUnfulfilled: null,
        completionRatePercent: null,
      });
    }
  });

  it('applies complementary suppression within a fixed period and geography bucket', () => {
    const projection = projectAggregateReporting('INTERNAL', [
      ...events(10),
      ...events(9, {
        resourceCategory: 'SHELTER',
        closureReason: 'UNFULFILLED',
        outcome: 'UNFULFILLED',
      }),
    ]);
    expect(projection.cells.map((cell) => cell.suppression).sort()).toEqual([
      'COMPLEMENTARY',
      'PRIMARY_K',
    ]);
    for (const cell of projection.cells) {
      expect(cell.requestsInitiated).toBeNull();
      expect(cell.completionRatePercent).toBeNull();
    }
  });

  it('accepts only fixed coarse dimensions and rejects extra row-level data', () => {
    expect(() =>
      projectAggregateReporting('INTERNAL', [
        {
          ...BASE_EVENT,
          userId: 'must-not-enter-the-projection',
        } as AggregateReportingEvent,
      ]),
    ).toThrow(/Unrecognized key/);
  });

  it('uses no mutable filters, provider identity, exact timestamp, or free-text field', () => {
    const projection = projectAggregateReporting('INTERNAL', events(10));
    expect(projection.fixedDimensions).toEqual([
      'period',
      'geographyLevel',
      'geographyCode',
      'resourceCategory',
      'providerCategory',
      'referralSource',
      'closureReason',
      'waitTimeBand',
    ]);
    expect(JSON.stringify(projection)).not.toMatch(
      /userId|providerId|timestamp|narrative|freeText|exactLocation/i,
    );
  });
});
