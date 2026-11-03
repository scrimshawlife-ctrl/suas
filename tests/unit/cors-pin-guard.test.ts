/**
 * Proposed SUAS-specs D-038 pin guard, unmocked: SUAS-specs ENVIRONMENT.md says a build
 * pinned below 0.7.0 rejects any non-empty SUAS_CORS_ALLOWED_ORIGINS at startup, with no
 * environment exempt.
 */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';
import { CORS_GUARD_SPEC_VERSION, SPEC_VERSION } from '../../src/release/pins.js';
import { validEnv } from '../helpers/env.js';

describe('CORS allowlist pin guard (unmocked)', () => {
  it('compares the released pin itself', () => {
    expect(SPEC_VERSION).toBe('0.6.0');
    expect(CORS_GUARD_SPEC_VERSION).toBe(SPEC_VERSION);
  });

  it.each([
    ['TEST', 'http://localhost:5173'],
    ['LOCAL', 'http://localhost:5173'],
    ['STAGING', 'https://app.example.org'],
  ])('fails startup in %s with a non-empty allowlist while pinned to 0.6.0', (env, origin) => {
    const load = () => loadConfig(validEnv({ SUAS_ENV: env, SUAS_CORS_ALLOWED_ORIGINS: origin }));
    expect(load).toThrow(ConfigurationError);
    expect(load).toThrow(/0\.7\.0/);
  });

  it('still starts with an empty allowlist', () => {
    for (const env of ['TEST', 'LOCAL']) {
      expect(
        loadConfig(validEnv({ SUAS_ENV: env, SUAS_CORS_ALLOWED_ORIGINS: '' })).corsAllowedOrigins,
      ).toEqual([]);
    }
  });
});
