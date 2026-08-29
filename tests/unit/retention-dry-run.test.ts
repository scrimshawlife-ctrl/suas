import { describe, expect, it } from 'vitest';
import {
  evaluateRetentionDryRun,
  RETENTION_DRY_RUN_ACTION,
  RETENTION_WINDOW_DAYS,
} from '../../src/privacy/index.js';

const CLOSED_AT = new Date('2025-08-29T12:00:00.000Z');
const BOUNDARY = new Date('2026-08-29T12:00:00.000Z');

describe('D-007 365-day retention dry-run', () => {
  it('uses the later of closure and participant activity and never authorizes a purge', () => {
    const evaluation = evaluateRetentionDryRun(
      {
        caseClosedAt: CLOSED_AT,
        lastParticipantActivityAt: new Date('2025-09-01T12:00:00.000Z'),
        exclusions: [],
      },
      BOUNDARY,
    );
    expect(RETENTION_WINDOW_DAYS).toBe(365);
    expect(evaluation).toMatchObject({
      action: RETENTION_DRY_RUN_ACTION,
      eligible: false,
      eligibleAfter: new Date('2026-09-01T12:00:00.000Z'),
      reasons: ['RETENTION_WINDOW_NOT_ELAPSED'],
    });
  });

  it('is eligible exactly at the 365-day boundary only when there are no exclusions', () => {
    const evaluation = evaluateRetentionDryRun(
      { caseClosedAt: CLOSED_AT, lastParticipantActivityAt: null, exclusions: [] },
      BOUNDARY,
    );
    expect(evaluation).toEqual({
      action: 'MANUAL_REVIEW_REQUIRED',
      eligible: true,
      eligibleAfter: BOUNDARY,
      reasons: [],
    });
  });

  it.each([
    'OPEN_CASE',
    'LEGAL_HOLD',
    'UNRESOLVED_SAFETY_OR_SECURITY_INCIDENT',
    'ACTIVE_PROVIDER_OR_PAYMENT_DISPUTE',
    'INCOMPLETE_EXPORT_OR_DELETION_REQUEST',
    'STATUTORY_RETENTION_OBLIGATION',
  ] as const)('retains a candidate covered by %s', (exclusion) => {
    const evaluation = evaluateRetentionDryRun(
      { caseClosedAt: CLOSED_AT, lastParticipantActivityAt: null, exclusions: [exclusion] },
      BOUNDARY,
    );
    expect(evaluation).toMatchObject({
      action: 'MANUAL_REVIEW_REQUIRED',
      eligible: false,
      reasons: [exclusion],
    });
  });

  it('does not infer eligibility when both required dates are unavailable', () => {
    expect(
      evaluateRetentionDryRun(
        { caseClosedAt: null, lastParticipantActivityAt: null, exclusions: [] },
        BOUNDARY,
      ),
    ).toEqual({
      action: 'MANUAL_REVIEW_REQUIRED',
      eligible: false,
      eligibleAfter: null,
      reasons: ['MISSING_CASE_CLOSURE_OR_PARTICIPANT_ACTIVITY'],
    });
  });
});
