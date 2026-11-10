/**
 * SUAS-specs D-038 pin guard at startup (released in 0.7.0): SUAS-specs ENVIRONMENT.md §3
 * says a build pinned below 0.7.0 rejects any non-empty SUAS_CORS_ALLOWED_ORIGINS at
 * startup in every SUAS_ENV, with no environment exempt.
 *
 * `cors-pin-guard.test.ts` covers the comparison function. This file proves that
 * `loadConfig` actually calls it, so removing the call from the config schema fails the
 * suite. The mock is file-scoped, so it lives in its own file: only the guard's pin is
 * lowered; SPEC_VERSION and SUAS_SPEC_VERSION stay at the build pin.
 */

import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

vi.mock('../../src/release/pins.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CORS_GUARD_SPEC_VERSION: '0.6.0',
}));

describe('loadConfig under a build pinned below spec 0.7.0', () => {
  it.each([
    ['TEST', 'http://localhost:5173'],
    ['LOCAL', 'http://localhost:5173'],
    ['STAGING', 'https://app.example.org'],
  ])('refuses a non-empty allowlist in %s', (env, origin) => {
    const attempt = () =>
      loadConfig(validEnv({ SUAS_ENV: env, SUAS_CORS_ALLOWED_ORIGINS: origin }));
    expect(attempt).toThrow(ConfigurationError);
    expect(attempt).toThrow(/needs a released spec of 0\.7\.0 or later/);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
  ])('still starts with an %s allowlist', (_label, value) => {
    const overrides = value === undefined ? {} : { SUAS_CORS_ALLOWED_ORIGINS: value };
    expect(loadConfig(validEnv(overrides)).corsAllowedOrigins).toEqual([]);
  });
});
