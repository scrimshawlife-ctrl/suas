/**
 * D-052: fake ID verification and public sign-up stay in LOCAL/TEST.
 * STAGING configuration fails closed when either is turned on.
 */

import { describe, expect, it } from 'vitest';
import {
  assertPublicSignUpPermitted,
  PublicSignUpRefusedError,
  stagingAccessFromConfig,
  stagingFixturePrincipalRefused,
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
    expect(config.stagingAuthEmails).toEqual(['fixture@example.invalid']);
    expect(config.stagingFixturePrincipals).toEqual([]);
    expect(config.idVerification.mode).toBe('disabled');
  });
});

describe('D-052 sign-up and fake ID', () => {
  it('refuses public sign-up on STAGING even if a caller asks for it', () => {
    expect(() =>
      assertPublicSignUpPermitted({
        environment: 'STAGING',
        publicSignUp: true,
        fixturePrincipals: [],
      }),
    ).toThrow(PublicSignUpRefusedError);
    expect(() =>
      assertPublicSignUpPermitted({
        environment: 'PRODUCTION',
        publicSignUp: true,
        fixturePrincipals: [],
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

  it('does not auto-verify a fake ID check on STAGING or PRODUCTION', () => {
    const config = loadConfig(validEnv({ SUAS_ID_VERIFICATION_MODE: 'fake' }));
    expect(() => createIdVerificationPort({ ...config, environment: 'STAGING' })).toThrow(
      /refused outside LOCAL and TEST/,
    );
    expect(() => createIdVerificationPort({ ...config, environment: 'PRODUCTION' })).toThrow(
      /refused outside LOCAL and TEST/,
    );
  });

  it('admits nobody when the registry is empty or missing, with demo mode on or off', () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const userId = '00000000-0000-4000-8000-000000000002';
    for (const demo of [undefined, 'enabled', 'disabled'] as const) {
      const config = loadConfig(
        validEnv({
          SUAS_ENV: 'STAGING',
          ...(demo === undefined ? {} : { SUAS_DEMO_FIXED_CODE: demo }),
        }),
      );
      const access = stagingAccessFromConfig(config);
      expect(access.fixturePrincipals).toEqual([]);
      expect(stagingFixturePrincipalRefused(access, { tenantId, userId })).toBe(true);
      expect(stagingFixturePrincipalRefused(access, undefined)).toBe(true);
    }
  });

  it('admits only the listed pair, not the same email in a second tenant', () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const userId = '00000000-0000-4000-8000-000000000002';
    const otherTenant = '00000000-0000-4000-8000-000000000003';
    const otherUser = '00000000-0000-4000-8000-000000000004';
    const config = loadConfig(
      validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_DEMO_FIXED_CODE: 'enabled',
        SUAS_STAGING_FIXTURE_REGISTRY: `${tenantId}:${userId}`,
      }),
    );
    const access = stagingAccessFromConfig(config);
    expect(access.fixturePrincipals).toEqual([{ tenantId, userId }]);
    expect(stagingFixturePrincipalRefused(access, { tenantId, userId })).toBe(false);
    expect(
      stagingFixturePrincipalRefused(access, { tenantId: otherTenant, userId: otherUser }),
    ).toBe(true);
    expect(stagingFixturePrincipalRefused(access, { tenantId, userId: otherUser })).toBe(true);
  });
});
