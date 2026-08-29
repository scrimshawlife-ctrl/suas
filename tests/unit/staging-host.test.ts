import { describe, expect, it } from 'vitest';
import { resolveSyntheticStagingOrigin } from '../../src/config/staging-host.js';

describe('resolveSyntheticStagingOrigin', () => {
  it('accepts an independently configured SUAS staging origin', () => {
    expect(resolveSyntheticStagingOrigin('https://staging.suas.example', 'SUAS_E2E_BASE_URL')).toBe(
      'https://staging.suas.example',
    );
  });

  it('requires an explicit configured origin', () => {
    expect(() => resolveSyntheticStagingOrigin(undefined, 'SUAS_E2E_BASE_URL')).toThrow(
      'There is intentionally no default deployment host',
    );
  });

  it('rejects the retired shared-account workers.dev host', () => {
    expect(() =>
      resolveSyntheticStagingOrigin(
        'https://suas.zer0state-noema.workers.dev',
        'SUAS_E2E_BASE_URL',
      ),
    ).toThrow('must not target the retired shared-account workers.dev host');
  });

  it('rejects insecure or non-origin values', () => {
    expect(() =>
      resolveSyntheticStagingOrigin('http://staging.suas.example', 'SUAS_E2E_BASE_URL'),
    ).toThrow('must use HTTPS');
    expect(() =>
      resolveSyntheticStagingOrigin(
        'https://staging.suas.example/auth/va/callback',
        'SUAS_E2E_BASE_URL',
      ),
    ).toThrow('must be an origin');
  });
});
