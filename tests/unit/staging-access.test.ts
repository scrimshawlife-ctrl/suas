/**
 * D-052: fake ID verification and public sign-up stay in LOCAL/TEST.
 * STAGING configuration fails closed when either is turned on.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPublicSignUpPermitted,
  PublicSignUpRefusedError,
} from '../../src/auth/staging-access.js';
import { loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { createIdVerificationPort } from '../../src/identity/id-verification.js';
import { validEnv } from '../helpers/env.js';

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

describe('D-052 startup refusal', () => {
  it('refuses fake ID verification on STAGING', () => {
    expect(
      issuesFor(validEnv({ SUAS_ENV: 'STAGING', SUAS_ID_VERIFICATION_MODE: 'fake' })),
    ).toContain('Fake ID verification is refused outside LOCAL and TEST');
  });

  it('refuses public sign-up on STAGING and PRODUCTION', () => {
    expect(issuesFor(validEnv({ SUAS_ENV: 'STAGING', SUAS_PUBLIC_SIGN_UP: 'enabled' }))).toContain(
      'SUAS_PUBLIC_SIGN_UP=enabled is refused outside LOCAL and TEST',
    );
    expect(
      issuesFor(validEnv({ SUAS_ENV: 'PRODUCTION', SUAS_PUBLIC_SIGN_UP: 'enabled' })),
    ).toContain('SUAS_PUBLIC_SIGN_UP=enabled is refused outside LOCAL and TEST');
  });

  it('refuses a STAGING principal list that is not synthetic', () => {
    const routable = ['person', 'gmail.com'].join('@');
    expect(
      issuesFor(
        validEnv({
          SUAS_ENV: 'STAGING',
          SUAS_STAGING_AUTH_EMAILS: routable,
        }),
      ),
    ).toContain('only synthetic fixture addresses');
  });

  it('accepts a synthetic fixture list and keeps sign-up off', () => {
    const config = loadConfig(
      validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_STAGING_AUTH_EMAILS: 'fixture@example.invalid',
        SUAS_PUBLIC_SIGN_UP: 'disabled',
      }),
    );
    expect(config.publicSignUp).toBe(false);
    expect(config.stagingFixturePrincipals).toEqual(['fixture@example.invalid']);
    expect(config.idVerification.mode).toBe('disabled');
  });
});

describe('D-052 sign-up and fake ID', () => {
  it('refuses public sign-up on STAGING even if a caller asks for it', () => {
    expect(() =>
      assertPublicSignUpPermitted({
        environment: 'STAGING',
        publicSignUp: true,
        fixturePrincipals: ['fixture@example.invalid'],
      }),
    ).toThrow(PublicSignUpRefusedError);
    expect(() => assertPublicSignUpPermitted(undefined)).toThrow(PublicSignUpRefusedError);
  });

  it('allows public sign-up only when LOCAL or TEST opted in', () => {
    expect(() =>
      assertPublicSignUpPermitted({
        environment: 'TEST',
        publicSignUp: true,
        fixturePrincipals: [],
      }),
    ).not.toThrow();
  });

  it('does not auto-verify a fake ID check on STAGING', () => {
    const config = loadConfig(validEnv({ SUAS_ID_VERIFICATION_MODE: 'fake' }));
    expect(() => createIdVerificationPort({ ...config, environment: 'STAGING' })).toThrow(
      /refused outside LOCAL and TEST/,
    );
  });
});
