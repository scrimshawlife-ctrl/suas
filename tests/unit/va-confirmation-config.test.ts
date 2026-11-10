/**
 * Config guards for VA Veteran Confirmation (suas-specs #72 R9.1, proposal;
 * D035_VA_CONFIRMATION_ADAPTER.md §5, §6, §14 items 2-4, 7, 9-10). Keys are synthetic.
 */

import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { createVeteranConfirmationPort } from '../../src/identity/va-confirmation-factory.js';
import { VA_CONFIRMATION_SANDBOX_BASE_URL } from '../../src/identity/va-confirmation.js';
import { validEnv } from '../helpers/env.js';

const KEY = 'synthetic-sandbox-key-1111';
const sandbox = (overrides: Record<string, string | undefined> = {}) =>
  validEnv({
    SUAS_ENV: 'LOCAL',
    SUAS_VA_CONFIRMATION_MODE: 'sandbox',
    SUAS_VA_CONFIRMATION_BASE_URL: VA_CONFIRMATION_SANDBOX_BASE_URL,
    SUAS_VA_CONFIRMATION_API_KEY: KEY,
    ...overrides,
  });

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

describe('VA confirmation config', () => {
  it('defaults to disabled, which builds no port', () => {
    const config = loadConfig(validEnv());
    expect(config.vaConfirmation.mode).toBe('disabled');
    expect(createVeteranConfirmationPort(config)).toBeUndefined();
  });

  it('allows the fixture in LOCAL and TEST only', () => {
    for (const env of ['LOCAL', 'TEST']) {
      const config = loadConfig(validEnv({ SUAS_ENV: env, SUAS_VA_CONFIRMATION_MODE: 'fixture' }));
      expect(createVeteranConfirmationPort(config)?.providerEnvironment).toBe('NONE');
    }
    for (const env of ['STAGING', 'PRODUCTION']) {
      expect(
        issuesFor(validEnv({ SUAS_ENV: env, SUAS_VA_CONFIRMATION_MODE: 'fixture' })),
      ).toContain('SUAS_VA_CONFIRMATION_MODE=fixture is allowed only in LOCAL and TEST');
    }
    const local = loadConfig(validEnv({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }));
    expect(() => createVeteranConfirmationPort({ ...local, environment: 'STAGING' })).toThrow(
      /refused outside LOCAL and TEST/,
    );
  });

  it('allows the sandbox in STAGING and LOCAL only', () => {
    for (const env of ['STAGING', 'LOCAL']) {
      const port = createVeteranConfirmationPort(loadConfig(sandbox({ SUAS_ENV: env })));
      expect(port?.providerEnvironment).toBe('SANDBOX');
    }
    expect(issuesFor(sandbox({ SUAS_ENV: 'PRODUCTION' }))).toContain(
      'SUAS_VA_CONFIRMATION_MODE=sandbox is forbidden in PRODUCTION',
    );
    expect(issuesFor(sandbox({ SUAS_ENV: 'TEST' }))).toContain(
      'SUAS_VA_CONFIRMATION_MODE=sandbox is allowed only in STAGING and LOCAL, not TEST',
    );
    const staging = loadConfig(sandbox({ SUAS_ENV: 'STAGING' }));
    for (const environment of ['PRODUCTION', 'TEST'] as const) {
      expect(() => createVeteranConfirmationPort({ ...staging, environment })).toThrow(
        `allowed only in STAGING and LOCAL, not ${environment}`,
      );
    }
  });

  it('refuses any base URL but the sandbox one, including the production host', () => {
    for (const url of [
      undefined,
      'https://api.va.gov/services/veteran-confirmation/v1',
      'https://attacker.example.invalid/services/veteran-confirmation/v1',
      `${VA_CONFIRMATION_SANDBOX_BASE_URL}/../x`,
      'http://sandbox-api.va.gov/services/veteran-confirmation/v1',
    ]) {
      expect(issuesFor(sandbox({ SUAS_VA_CONFIRMATION_BASE_URL: url }))).toContain(
        'SUAS_VA_CONFIRMATION_BASE_URL must be exactly',
      );
    }
  });

  it('refuses a missing or malformed key without echoing it', () => {
    expect(issuesFor(sandbox({ SUAS_VA_CONFIRMATION_API_KEY: undefined }))).toContain(
      'SUAS_VA_CONFIRMATION_API_KEY is required',
    );
    const malformed = issuesFor(sandbox({ SUAS_VA_CONFIRMATION_API_KEY: 'two words\nheader' }));
    expect(malformed).toContain('SUAS_VA_CONFIRMATION_API_KEY is malformed');
    expect(malformed).not.toContain('two words');
  });

  it('accepts only the released projection id', () => {
    expect(
      loadConfig(
        sandbox({ SUAS_VA_CONFIRMATION_PROJECTION_ID: 'VA_CONFIRMATION_V1_REQUIRED_ONLY' }),
      ).vaConfirmation.mode,
    ).toBe('sandbox');
    expect(issuesFor(sandbox({ SUAS_VA_CONFIRMATION_PROJECTION_ID: 'WITH_SSN' }))).toContain(
      'SUAS_VA_CONFIRMATION_PROJECTION_ID must be VA_CONFIRMATION_V1_REQUIRED_ONLY',
    );
  });

  it('shows the key only as a configured flag', () => {
    const described = describeConfig(loadConfig(sandbox()));
    expect(described.va_confirmation_mode).toBe('sandbox');
    expect(described.va_confirmation_api_key_configured).toBe(true);
    expect(JSON.stringify(described)).not.toContain(KEY);
  });
});
