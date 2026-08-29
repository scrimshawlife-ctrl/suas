import { describe, expect, it } from 'vitest';
import {
  projectApprovedReporting,
  REPORTING_MINIMUM_K,
  REPORTING_RELEASE_STATE,
  type ApprovedReportingEvent,
} from '../../src/reporting/index.js';

const BASE_EVENT: ApprovedReportingEvent = {
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
  overrides: Partial<ApprovedReportingEvent> = {},
): ApprovedReportingEvent[] {
  return Array.from({ length: count }, () => ({ ...BASE_EVENT, ...overrides }));
}

describe('D-025 approved reporting projection', () => {
  it('keeps reporting implementation disabled pending release evidence', () => {
    const projection = projectApprovedReporting('INTERNAL', []);
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
  ] as const)('applies the approved %s threshold at k=%i', (audience, count, suppression) => {
    const projection = projectApprovedReporting(audience, events(count));
    expect(projection.minimumK).toBe(REPORTING_MINIMUM_K[audience]);
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
    const projection = projectApprovedReporting('INTERNAL', [
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
      projectApprovedReporting('INTERNAL', [
        {
          ...BASE_EVENT,
          userId: 'must-not-enter-the-projection',
        } as ApprovedReportingEvent,
      ]),
    ).toThrow(/Unrecognized key/);
  });

  it('uses no mutable filters, provider identity, exact timestamp, or free-text field', () => {
    const projection = projectApprovedReporting('INTERNAL', events(10));
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
