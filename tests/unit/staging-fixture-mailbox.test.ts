/**
 * R11.7 (contributor proposal, specs #75): plus addresses of one configured STAGING mailbox
 * count as fixture addresses, so emailed sign-in codes arrive. The bare mailbox never does.
 * Routable addresses are built at run time (repository hygiene, TESTING.md §12).
 */

import { describe, expect, it } from 'vitest';
import { isStagingFixtureAddress } from '../../src/auth/staging-access.js';
import { tryLoadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

const MAILBOX = ['owner', 'gmail.com'].join('@');
const plus = (tag: string, local = 'owner', domain = 'gmail.com'): string =>
  `${local}+${tag}${['', domain].join('@')}`;

function issuesFor(overrides: Record<string, string>): string[] {
  const result = tryLoadConfig(validEnv(overrides));
  return result.ok ? [] : [...result.issues];
}

describe('isStagingFixtureAddress', () => {
  it('accepts synthetic addresses with or without a mailbox', () => {
    expect(isStagingFixtureAddress('vet1@example.invalid', undefined)).toBe(true);
    expect(isStagingFixtureAddress('vet1@example.invalid', MAILBOX)).toBe(true);
  });

  it('accepts a plus address of the mailbox, case-insensitively', () => {
    expect(isStagingFixtureAddress(plus('vet-1'), MAILBOX)).toBe(true);
    expect(isStagingFixtureAddress(plus('VET1', 'Owner', 'GMail.com'), MAILBOX)).toBe(true);
  });

  it('refuses the bare mailbox, another mailbox, a bad tag, and plus addresses with no mailbox set', () => {
    expect(isStagingFixtureAddress(MAILBOX, MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus('vet1', 'someone'), MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus('vet1', 'owner', 'gmail.org'), MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus(''), MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus('vet_1'), MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus('a+b'), MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus('x'.repeat(33)), MAILBOX)).toBe(false);
    expect(isStagingFixtureAddress(plus('vet1'), undefined)).toBe(false);
  });
});

describe('SUAS_STAGING_FIXTURE_MAILBOX', () => {
  const staging = { SUAS_ENV: 'STAGING', SUAS_ID_VERIFICATION_MODE: 'disabled' };

  it('in STAGING, lets SUAS_STAGING_AUTH_EMAILS list its plus addresses', () => {
    const result = tryLoadConfig(
      validEnv({
        ...staging,
        SUAS_STAGING_FIXTURE_MAILBOX: MAILBOX,
        SUAS_STAGING_AUTH_EMAILS: `${plus('vet1')},helper@example.invalid`,
      }),
    );
    expect(result.ok ? result.config.stagingFixtureMailbox : result.issues).toBe(MAILBOX);
  });

  it('still refuses the bare mailbox as a fixture address', () => {
    expect(
      issuesFor({
        ...staging,
        SUAS_STAGING_FIXTURE_MAILBOX: MAILBOX,
        SUAS_STAGING_AUTH_EMAILS: MAILBOX,
      }),
    ).toContainEqual(expect.stringContaining('SUAS_STAGING_AUTH_EMAILS must contain only'));
  });

  it('is refused outside STAGING, and must be one plain address', () => {
    for (const env of ['TEST', 'LOCAL', 'PRODUCTION']) {
      expect(issuesFor({ SUAS_ENV: env, SUAS_STAGING_FIXTURE_MAILBOX: MAILBOX }), env).toContain(
        'SUAS_STAGING_FIXTURE_MAILBOX is STAGING-only.',
      );
    }
    for (const value of [plus('tag'), 'not-an-address', `${MAILBOX},${MAILBOX}`]) {
      expect(issuesFor({ ...staging, SUAS_STAGING_FIXTURE_MAILBOX: value }), value).toContain(
        'SUAS_STAGING_FIXTURE_MAILBOX must be one email address without a +tag.',
      );
    }
  });
});
