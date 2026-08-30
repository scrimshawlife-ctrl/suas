import { describe, expect, it } from 'vitest';
import { syntheticStagingContractErrors } from '../../scripts/check-synthetic-staging-contract.js';

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

describe('synthetic STAGING contract', () => {
  it('accepts the required synthetic-only configuration', () => {
    expect(syntheticStagingContractErrors(safeSyntheticStagingConfig)).toEqual([]);
  });

  it('rejects missing and unsafe staging modes', () => {
    const errors = syntheticStagingContractErrors({
      ...safeSyntheticStagingConfig,
      SUAS_ENV: undefined,
      SUAS_EMAIL_MODE: 'sink',
    });

    expect(errors).toContain('SUAS_ENV must be "STAGING".');
    expect(errors).toContain('SUAS_EMAIL_MODE must be "resend".');
  });

  it('rejects public secrets, committed Resend secrets, and pilot-marked endpoints', () => {
    const errors = syntheticStagingContractErrors({
      ...safeSyntheticStagingConfig,
      VITE_RESEND_API_KEY: 'not-allowed',
      RESEND_API_KEY: 'not-allowed',
      SUAS_TRANSPORTATION_API_BASE_URL: 'https://pilot.example.test',
    });

    expect(errors).toContain('VITE_RESEND_API_KEY has a public prefix and a secret-like name.');
    expect(errors).toContain('RESEND_API_KEY must not be configured for synthetic STAGING.');
    expect(errors).toContain(
      'SUAS_TRANSPORTATION_API_BASE_URL points at a pilot or production-marked endpoint.',
    );
  });
});
