import { describe, expect, it } from 'vitest';
import {
  syntheticStagingEvidenceInvariantErrors,
  SYNTHETIC_STAGING_CAMPAIGN_AUTHORITY,
} from '../../scripts/synthetic-staging-evidence-invariants.js';

const safeSyntheticStagingConfig = {
  SUAS_ENV: 'STAGING',
  SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
  SUAS_MIGRATIONS_MODE: 'validate',
  SUAS_BROWSER_AUTH_MODE: 'email_otp',
  SUAS_BROWSER_TENANT_ID: '00000000-0000-4000-8000-000000000001',
  SUAS_EMAIL_MODE: 'resend',
  SUAS_SMS_MODE: 'sink',
  SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
  SUAS_SHELTER_ADAPTER_MODE: 'fake',
  SUAS_FOOD_ADAPTER_MODE: 'fake',
  SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
  SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
  SUAS_SAFETY_COPY_MODE: 'placeholder_test_only',
  SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
};

describe('synthetic STAGING evidence campaign invariants', () => {
  it('pins every campaign authority state to a non-operational value', () => {
    expect(SYNTHETIC_STAGING_CAMPAIGN_AUTHORITY).toEqual({
      D007_DELETION_EXECUTION: 'disabled',
      D007_EXPORT_DELIVERY: 'disabled',
      D007_365_DAY_PURGE: 'disabled',
      D025_REPORTING: 'disabled',
      REAL_WORLD_EFFECTS: 'disabled',
      PILOT_LAUNCH: 'blocked',
      PRODUCTION_LAUNCH: 'blocked',
    });
  });

  it('accepts only the committed safe synthetic-STAGING configuration', () => {
    expect(syntheticStagingEvidenceInvariantErrors(safeSyntheticStagingConfig)).toEqual([]);
  });

  it('rejects effects and reporting if either is enabled', () => {
    const errors = syntheticStagingEvidenceInvariantErrors({
      ...safeSyntheticStagingConfig,
      SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'true',
      SUAS_SENSITIVE_AGGREGATE_REPORTING: 'enabled',
    });
    expect(errors).toContain('REAL_WORLD_EFFECTS must remain disabled.');
    expect(errors).toContain('D025_REPORTING must remain disabled.');
  });
});
