/**
 * Config guards for the licence reader (suas-specs R10.1, proposal; L9.1): where each mode
 * may run, the fail-closed fingerprint key, and secrets kept out of config output.
 */

import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

const TOKEN = 'synthetic-scry-token-2222';

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

const staging = (overrides: Record<string, string | undefined>) =>
  validEnv({
    SUAS_ENV: 'STAGING',
    SUAS_OBJECT_STORAGE_MODE: 'fake',
    SUAS_LICENCE_READER_MODE: 'scry',
    ...overrides,
  });

describe('licence reader config', () => {
  it('is disabled by default and PRODUCTION allows nothing else', () => {
    expect(loadConfig(validEnv()).licenceReader.mode).toBe('disabled');
    for (const mode of ['fixture', 'scry']) {
      expect(
        issuesFor(
          validEnv({
            SUAS_ENV: 'PRODUCTION',
            SUAS_LICENCE_READER_MODE: mode,
            SUAS_OBJECT_STORAGE_MODE: 'fake',
          }),
        ),
      ).toContain(`SUAS_LICENCE_READER_MODE=${mode} is forbidden in PRODUCTION`);
    }
  });

  it('keeps the fixture to LOCAL and TEST and Scry to LOCAL and STAGING', () => {
    expect(issuesFor(staging({ SUAS_LICENCE_READER_MODE: 'fixture' }))).toContain(
      'SUAS_LICENCE_READER_MODE=fixture is allowed only in LOCAL and TEST',
    );
    expect(
      issuesFor(validEnv({ SUAS_LICENCE_READER_MODE: 'scry', SUAS_OBJECT_STORAGE_MODE: 'fake' })),
    ).toContain('SUAS_LICENCE_READER_MODE=scry is allowed only in LOCAL and STAGING, not TEST');
    expect(
      loadConfig(
        validEnv({ SUAS_LICENCE_READER_MODE: 'fixture', SUAS_OBJECT_STORAGE_MODE: 'fake' }),
      ).licenceReader.mode,
    ).toBe('fixture');
  });

  it('fails closed without the fingerprint key, object storage or the STAGING marker', () => {
    const fixture = { SUAS_LICENCE_READER_MODE: 'fixture', SUAS_OBJECT_STORAGE_MODE: 'fake' };
    expect(
      issuesFor(
        validEnv({
          ...fixture,
          SUAS_FINGERPRINT_KEY: undefined,
          SUAS_FINGERPRINT_KEY_ID: undefined,
        }),
      ),
    ).toContain('SUAS_FINGERPRINT_KEY is required when SUAS_LICENCE_READER_MODE is not disabled');
    expect(issuesFor(validEnv({ SUAS_LICENCE_READER_MODE: 'fixture' }))).toContain(
      'SUAS_LICENCE_READER_MODE needs object storage',
    );
    expect(issuesFor(staging({}))).toContain(
      'SUAS_LICENCE_SYNTHETIC_IIN is required when SUAS_LICENCE_READER_MODE=scry in STAGING',
    );
    expect(issuesFor(staging({ SUAS_LICENCE_SYNTHETIC_IIN: '99999' }))).toContain(
      'SUAS_LICENCE_SYNTHETIC_IIN must be exactly 6 digits',
    );
    for (const real of ['636014', '604428']) {
      expect(issuesFor(staging({ SUAS_LICENCE_SYNTHETIC_IIN: real }))).toContain(
        'must not be in the 636xxx or 604xxx jurisdiction blocks',
      );
    }
  });

  it('takes the Scry URL over HTTPS only, and never shows the token', () => {
    expect(
      issuesFor(
        staging({ SUAS_LICENCE_SYNTHETIC_IIN: '999999', SUAS_SCRY_BASE_URL: 'http://localhost' }),
      ),
    ).toContain('SUAS_SCRY_BASE_URL must use HTTPS');
    const env = staging({
      SUAS_LICENCE_SYNTHETIC_IIN: '999999',
      SUAS_SCRY_BASE_URL: 'https://reader.example.test',
      SUAS_SCRY_API_TOKEN: TOKEN,
    });
    const result = tryLoadConfig(env);
    // Other STAGING rules may still refuse this env; only the licence ones matter here.
    const licenceIssues = result.ok
      ? []
      : result.issues.filter((text) => /LICENCE|SCRY/.test(text));
    expect(licenceIssues).toEqual([]);
    const local = loadConfig(
      validEnv({
        SUAS_ENV: 'LOCAL',
        SUAS_OBJECT_STORAGE_MODE: 'fake',
        SUAS_LICENCE_READER_MODE: 'scry',
        SUAS_SCRY_BASE_URL: 'http://localhost:8080',
        SUAS_SCRY_API_TOKEN: TOKEN,
      }),
    );
    expect(local.licenceReader.scryApiToken).toBe(TOKEN);
    expect(JSON.stringify(describeConfig(local))).not.toContain(TOKEN);
  });
});
