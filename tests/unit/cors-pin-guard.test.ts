/**
 * SUAS-specs D-038 pin guard (released in 0.7.0), unmocked: SUAS-specs ENVIRONMENT.md §3
 * says a build pinned below 0.7.0 rejects any non-empty SUAS_CORS_ALLOWED_ORIGINS at
 * startup, with no environment exempt.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { corsPinIssue } from '../../src/config/cors-origins.js';
import { CORS_GUARD_SPEC_VERSION, SPEC_VERSION } from '../../src/release/pins.js';
import { validEnv } from '../helpers/env.js';

describe('CORS allowlist pin guard (unmocked)', () => {
  it('compares the released pin itself', () => {
    expect(SPEC_VERSION).toBe('0.7.0');
    expect(CORS_GUARD_SPEC_VERSION).toBe(SPEC_VERSION);
  });

  it.each(['0.6.0', '0.6.9', '0.1.0'])('refuses a non-empty allowlist under pin %s', (pin) => {
    expect(corsPinIssue(['https://app.example.org'], pin)).toMatch(/0\.7\.0/);
    expect(corsPinIssue([], pin)).toBeUndefined();
  });

  it.each(['0.7.0', '0.7.1', '0.8.0', '1.0.0'])('allows the allowlist under pin %s', (pin) => {
    expect(corsPinIssue(['https://app.example.org'], pin)).toBeUndefined();
  });

  it.each([
    ['TEST', 'http://localhost:5173'],
    ['LOCAL', 'http://localhost:5173'],
    ['STAGING', 'https://app.example.org'],
  ])('starts in %s with a non-empty allowlist at the 0.7.0 pin', (env, origin) => {
    expect(
      loadConfig(validEnv({ SUAS_ENV: env, SUAS_CORS_ALLOWED_ORIGINS: origin })).corsAllowedOrigins,
    ).toEqual([origin]);
  });
});
