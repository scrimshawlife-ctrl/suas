/**
 * R16.1 (contributor proposal, not released): SUAS_PUBLIC_DEMO is accepted on STAGING,
 * refused in PRODUCTION, and accepts only "enabled" or "disabled".
 */

import { describe, expect, it } from 'vitest';
import { startApp } from '../../src/app.js';
import { loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

describe('SUAS_PUBLIC_DEMO startup validation', () => {
  it('accepts enabled on STAGING and defaults to off', () => {
    expect(
      loadConfig(validEnv({ SUAS_ENV: 'STAGING', SUAS_PUBLIC_DEMO: 'enabled' })).publicDemo,
    ).toBe(true);
    expect(loadConfig(validEnv({ SUAS_ENV: 'STAGING' })).publicDemo).toBe(false);
  });

  it('refuses enabled in PRODUCTION', () => {
    expect(issuesFor(validEnv({ SUAS_ENV: 'PRODUCTION', SUAS_PUBLIC_DEMO: 'enabled' }))).toContain(
      'SUAS_PUBLIC_DEMO=enabled is refused in PRODUCTION.',
    );
  });

  // Owner review on #363: the caps are settings, positive integers, failing closed.
  it('reads the demo caps as settings with defaults and refuses an invalid one', () => {
    expect(loadConfig(validEnv({ SUAS_ENV: 'STAGING' })).publicDemoLimits).toEqual({
      dailySignUpCap: 200,
      addressDailyCap: 5,
      routeLimitPerMinute: 120,
    });
    const set = loadConfig(
      validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_PUBLIC_DEMO_DAILY_SIGNUP_CAP: '10',
        SUAS_PUBLIC_DEMO_ADDRESS_DAILY_CAP: '2',
        SUAS_PUBLIC_DEMO_ROUTE_LIMIT_PER_MINUTE: '30',
      }),
    );
    expect(set.publicDemoLimits).toEqual({
      dailySignUpCap: 10,
      addressDailyCap: 2,
      routeLimitPerMinute: 30,
    });
    for (const value of ['0', '-1', '2.5', 'many']) {
      expect(
        issuesFor(validEnv({ SUAS_ENV: 'STAGING', SUAS_PUBLIC_DEMO_ADDRESS_DAILY_CAP: value })),
      ).toContain('SUAS_PUBLIC_DEMO_ADDRESS_DAILY_CAP');
    }
  });

  // R16.1 (contributor's call, D-065): the refusal holds at app startup, before any database work.
  it('refuses to start the app in PRODUCTION with the flag on', async () => {
    const env = validEnv({
      SUAS_ENV: 'PRODUCTION',
      SUAS_SESSION_SECRET: 'a'.repeat(48),
      SUAS_PUBLIC_DEMO: 'enabled',
    });
    await expect(startApp({ env, listen: false })).rejects.toThrow(
      'SUAS_PUBLIC_DEMO=enabled is refused in PRODUCTION.',
    );
  });

  it('refuses a value other than enabled or disabled', () => {
    expect(issuesFor(validEnv({ SUAS_ENV: 'STAGING', SUAS_PUBLIC_DEMO: 'true' }))).toContain(
      'SUAS_PUBLIC_DEMO must be exactly "enabled" or "disabled" when set.',
    );
  });
});
