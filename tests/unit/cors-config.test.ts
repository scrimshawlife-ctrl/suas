/** SUAS_CORS_ALLOWED_ORIGINS configuration rules (proposed SUAS-specs D-038). */

import { describe, expect, it, vi } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

// The released pin is 0.6.0, and the D-038 startup guard refuses a non-empty allowlist
// below 0.7.0 in every environment. Mock only the guard's pin so this file can exercise
// the draft path; SPEC_VERSION and SUAS_SPEC_VERSION stay 0.6.0.
vi.mock('../../src/release/pins.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CORS_GUARD_SPEC_VERSION: '0.7.0',
}));

describe('SUAS_CORS_ALLOWED_ORIGINS', () => {
  it('defaults to no allowed origins', () => {
    expect(loadConfig(validEnv()).corsAllowedOrigins).toEqual([]);
    expect(loadConfig(validEnv({ SUAS_CORS_ALLOWED_ORIGINS: '' })).corsAllowedOrigins).toEqual([]);
  });

  it('exposes the normalised exact origins', () => {
    const config = loadConfig(
      validEnv({ SUAS_CORS_ALLOWED_ORIGINS: 'https://app.example.org/,http://localhost:5173' }),
    );
    expect(config.corsAllowedOrigins).toEqual(['https://app.example.org', 'http://localhost:5173']);
  });

  it.each([
    ['a wildcard', '*'],
    ['a subdomain wildcard', 'https://*.example.org'],
    ['a trailing-dot host', 'https://app.example.org.'],
    ['a percent-encoded wildcard', 'https://%2a.example.org'],
    ['an empty host label', 'https://app..example.org'],
    ['a path', 'https://app.example.org/x'],
    ['plain http on a public host', 'http://app.example.org'],
  ])('fails startup closed for %s', (_label, value) => {
    expect(() => loadConfig(validEnv({ SUAS_CORS_ALLOWED_ORIGINS: value }))).toThrow(
      ConfigurationError,
    );
  });

  it('rejects loopback http outside LOCAL and TEST', () => {
    expect(() =>
      loadConfig(
        validEnv({
          SUAS_ENV: 'STAGING',
          SUAS_CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
        }),
      ),
    ).toThrow(ConfigurationError);
  });

  it('fails startup for an https loopback origin in STAGING', () => {
    expect(() =>
      loadConfig(
        validEnv({ SUAS_ENV: 'STAGING', SUAS_CORS_ALLOWED_ORIGINS: 'https://localhost:8443' }),
      ),
    ).toThrow(/loopback names and IP literals/);
  });
});
