/**
 * D-052: fake ID verification and public sign-up stay in LOCAL/TEST.
 * STAGING configuration fails closed when either is turned on.
 */

import { describe, expect, it } from 'vitest';
import {
  publicDemoActive,
  publicSignUpPermitted,
  stagingAccessFromConfig,
  stagingFixturePrincipalRefused,
  vaConfirmationFixtureRefused,
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
  it('permits public sign-up only in LOCAL or TEST', () => {
    const access = { publicSignUp: true, fixturePrincipals: [] };
    expect(publicSignUpPermitted({ ...access, environment: 'STAGING' })).toBe(false);
    expect(publicSignUpPermitted({ ...access, environment: 'PRODUCTION' })).toBe(false);
    expect(publicSignUpPermitted(undefined)).toBe(false);
    expect(publicSignUpPermitted({ ...access, environment: 'TEST' })).toBe(true);
    expect(publicSignUpPermitted({ ...access, environment: 'LOCAL' })).toBe(true);
  });

  it('decides by environment only; the opt-in flag belongs to startup config', () => {
    const access = { publicSignUp: false, fixturePrincipals: [] };
    expect(publicSignUpPermitted({ ...access, environment: 'TEST' })).toBe(true);
    expect(publicSignUpPermitted({ ...access, environment: 'STAGING' })).toBe(false);
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

// R16.1 (contributor proposal, not released): STAGING public demo opens sign-up and the gate.
describe('R16.1 public demo on STAGING', () => {
  const stranger = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
  };
  const staging = { environment: 'STAGING', publicSignUp: false, fixturePrincipals: [] } as const;

  it('permits sign-up and admits an unregistered principal only with the flag on', () => {
    expect(publicSignUpPermitted({ ...staging, publicDemo: true })).toBe(true);
    expect(publicSignUpPermitted({ ...staging, publicDemo: false })).toBe(false);
    expect(stagingFixturePrincipalRefused({ ...staging, publicDemo: true }, stranger)).toBe(false);
    expect(stagingFixturePrincipalRefused({ ...staging, publicDemo: false }, stranger)).toBe(true);
  });

  it('is active on STAGING only, never in PRODUCTION', () => {
    expect(publicDemoActive({ ...staging, publicDemo: true })).toBe(true);
    const production = { ...staging, environment: 'PRODUCTION', publicDemo: true } as const;
    expect(publicDemoActive(production)).toBe(false);
    expect(publicSignUpPermitted(production)).toBe(false);
  });

  // R16.1 (contributor's call, D-065): demo mode never lifts the VA gate, so an empty
  // registry still refuses every principal, known or not.
  it('refuses VA confirmation for any principal when the registry is empty', () => {
    const demo = { ...staging, publicDemo: true };
    expect(vaConfirmationFixtureRefused(demo, stranger)).toBe(true);
    expect(vaConfirmationFixtureRefused(demo, undefined)).toBe(true);
  });
});

// R16.5 (contributor's call, D-065): with no access the environment is unknown, so the gates refuse.
describe('missing staging access fails closed', () => {
  const principal = {
    tenantId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
  };

  it('refuses VA confirmation and the account gate without access', () => {
    expect(vaConfirmationFixtureRefused(undefined, principal)).toBe(true);
    expect(stagingFixturePrincipalRefused(undefined, principal)).toBe(true);
  });
});
