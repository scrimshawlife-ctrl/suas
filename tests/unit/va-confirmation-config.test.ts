/**
 * Config guards for VA Veteran Confirmation (suas-specs #72 R9.1, released in 0.10.0;
 * D035_VA_CONFIRMATION_ADAPTER.md §5, §6, §14 items 2-4, 7, 9-10). Keys are synthetic.
 */

import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { createVeteranConfirmationPort } from '../../src/identity/va-confirmation-factory.js';
import { VA_CONFIRMATION_SANDBOX_BASE_URL } from '../../src/identity/va-confirmation.js';
import { startApp } from '../../src/app.js';
import { TEST_FINGERPRINT_KEY, TEST_FINGERPRINT_KEY_ID, validEnv } from '../helpers/env.js';
import { approvedVaProjection } from '../helpers/va-projection.js';

const KEY = 'synthetic-sandbox-key-1111';
const sandbox = (overrides: Record<string, string | undefined> = {}) =>
  validEnv({
    SUAS_ENV: 'LOCAL',
    SUAS_VA_CONFIRMATION_MODE: 'sandbox',
    SUAS_VA_CONFIRMATION_BASE_URL: VA_CONFIRMATION_SANDBOX_BASE_URL,
    SUAS_VA_CONFIRMATION_API_KEY: KEY,
    ...overrides,
  });

// STAGING reaches VA only through the outside-VPC verify function (W9 item 4).
const viaRelay = (overrides: Record<string, string | undefined> = {}) =>
  sandbox({
    SUAS_ENV: 'STAGING',
    SUAS_VA_CONFIRMATION_BASE_URL: undefined,
    SUAS_VA_CONFIRMATION_API_KEY: undefined,
    SUAS_VA_CONFIRMATION_RELAY_FUNCTION: 'suas-va-verify',
    SUAS_AWS_REGION: 'us-west-2',
    ...overrides,
  });

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

describe('VA confirmation config', () => {
  it('fails startup closed when VA confirmation is on without a fingerprint key', async () => {
    const fixture = { SUAS_VA_CONFIRMATION_MODE: 'fixture' };
    const missing = validEnv({ ...fixture, SUAS_FINGERPRINT_KEY: undefined });
    expect(issuesFor(missing)).toContain(
      'SUAS_FINGERPRINT_KEY is required when SUAS_VA_CONFIRMATION_MODE is not disabled',
    );
    await expect(startApp({ env: missing, listen: false })).rejects.toThrow(/SUAS_FINGERPRINT_KEY/);
    expect(issuesFor(validEnv({ ...fixture, SUAS_FINGERPRINT_KEY_ID: undefined }))).toContain(
      'SUAS_FINGERPRINT_KEY_ID is required with its key',
    );
    // Disabled needs no key.
    expect(
      loadConfig(validEnv({ SUAS_FINGERPRINT_KEY: undefined, SUAS_FINGERPRINT_KEY_ID: undefined }))
        .fingerprintKeys,
    ).toBeUndefined();
  });

  it('needs base64 of at least 32 bytes, not the session secret, and never shows a key', () => {
    const fixture = { SUAS_VA_CONFIRMATION_MODE: 'fixture' };
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(issuesFor(validEnv({ ...fixture, SUAS_FINGERPRINT_KEY: short }))).toContain(
      'SUAS_FINGERPRINT_KEY is malformed',
    );
    const reused = Buffer.alloc(32, 2).toString('base64');
    expect(
      issuesFor(
        validEnv({ ...fixture, SUAS_FINGERPRINT_KEY: reused, SUAS_SESSION_SECRET: reused }),
      ),
    ).toContain('SUAS_FINGERPRINT_KEY must differ from SUAS_SESSION_SECRET');
    const described = JSON.stringify(describeConfig(loadConfig(validEnv(fixture))));
    expect(described).not.toContain(TEST_FINGERPRINT_KEY);
    expect(described).toContain(TEST_FINGERPRINT_KEY_ID);
  });

  it('takes a verify-only previous key with its own id during a rotation', () => {
    const previous = Buffer.alloc(32, 3).toString('base64');
    const rotating = validEnv({
      SUAS_FINGERPRINT_KEY_PREVIOUS: previous,
      SUAS_FINGERPRINT_KEY_PREVIOUS_ID: 'old-k0',
    });
    expect(loadConfig(rotating).fingerprintKeys).toEqual({
      current: { id: TEST_FINGERPRINT_KEY_ID, secret: TEST_FINGERPRINT_KEY },
      previous: { id: 'old-k0', secret: previous },
    });
    expect(issuesFor(validEnv({ SUAS_FINGERPRINT_KEY_PREVIOUS: previous }))).toContain(
      'SUAS_FINGERPRINT_KEY_PREVIOUS_ID is required with its key',
    );
    expect(
      issuesFor(
        validEnv({
          SUAS_FINGERPRINT_KEY_PREVIOUS: previous,
          SUAS_FINGERPRINT_KEY_PREVIOUS_ID: TEST_FINGERPRINT_KEY_ID,
        }),
      ),
    ).toContain('SUAS_FINGERPRINT_KEY_PREVIOUS_ID must differ from SUAS_FINGERPRINT_KEY_ID');
  });

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
    for (const env of [viaRelay(), sandbox({ SUAS_ENV: 'LOCAL' })]) {
      const port = createVeteranConfirmationPort(loadConfig(env), {
        projection: approvedVaProjection(),
      });
      expect(port?.providerEnvironment).toBe('SANDBOX');
    }
    expect(issuesFor(sandbox({ SUAS_ENV: 'PRODUCTION' }))).toContain(
      'SUAS_VA_CONFIRMATION_MODE=sandbox is forbidden in PRODUCTION',
    );
    expect(issuesFor(sandbox({ SUAS_ENV: 'TEST' }))).toContain(
      'SUAS_VA_CONFIRMATION_MODE=sandbox is allowed only in STAGING and LOCAL, not TEST',
    );
    const staging = loadConfig(viaRelay());
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

  describe('through the verify function (W9 item 4)', () => {
    it('selects the relay with no key or base URL in this process; LOCAL stays direct', () => {
      const config = loadConfig(viaRelay());
      expect(config.vaConfirmation.relayFunction).toBe('suas-va-verify');
      expect(config.vaConfirmation.apiKey).toBeUndefined();
      expect(describeConfig(config).va_confirmation_relay_configured).toBe(true);
      const options = { projection: approvedVaProjection() };
      expect(createVeteranConfirmationPort(config, options)?.implementation).toBe(
        'va-confirmation-lambda-relay',
      );
      expect(createVeteranConfirmationPort(loadConfig(sandbox()), options)?.implementation).toBe(
        'va-confirmation-http',
      );
    });

    it('refuses a direct VA call from STAGING', () => {
      expect(issuesFor(sandbox({ SUAS_ENV: 'STAGING' }))).toContain(
        'SUAS_VA_CONFIRMATION_MODE=sandbox in STAGING requires SUAS_VA_CONFIRMATION_RELAY_FUNCTION',
      );
    });

    it('refuses the key beside the relay, a wrong base URL, no region, or a bad name', () => {
      const issues = issuesFor(
        viaRelay({
          SUAS_VA_CONFIRMATION_API_KEY: KEY,
          SUAS_VA_CONFIRMATION_BASE_URL: 'https://api.va.gov/services/veteran-confirmation/v1',
          SUAS_AWS_REGION: undefined,
        }),
      );
      expect(issues).toContain(
        'SUAS_VA_CONFIRMATION_API_KEY must not be set with SUAS_VA_CONFIRMATION_RELAY_FUNCTION',
      );
      expect(issues).not.toContain(KEY);
      expect(issues).toContain('SUAS_VA_CONFIRMATION_BASE_URL must be exactly');
      expect(issues).toContain('SUAS_AWS_REGION is required');
      expect(issuesFor(viaRelay({ SUAS_VA_CONFIRMATION_RELAY_FUNCTION: 'not a name' }))).toContain(
        'SUAS_VA_CONFIRMATION_RELAY_FUNCTION must be a Lambda function name or ARN',
      );
    });

    it('accepts the relay only with sandbox mode', () => {
      for (const mode of ['disabled', 'fixture']) {
        expect(
          issuesFor(
            validEnv({
              SUAS_VA_CONFIRMATION_MODE: mode,
              SUAS_VA_CONFIRMATION_RELAY_FUNCTION: 'suas-va-verify',
              SUAS_AWS_REGION: 'us-west-2',
            }),
          ),
        ).toContain(
          'SUAS_VA_CONFIRMATION_RELAY_FUNCTION is allowed only with SUAS_VA_CONFIRMATION_MODE=sandbox',
        );
      }
    });
  });

  it('shows the key only as a configured flag', () => {
    const described = describeConfig(loadConfig(sandbox()));
    expect(described.va_confirmation_mode).toBe('sandbox');
    expect(described.va_confirmation_api_key_configured).toBe(true);
    expect(JSON.stringify(described)).not.toContain(KEY);
  });
});
