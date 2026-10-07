import { describe, expect, it } from 'vitest';

import { loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

function issuesFor(env: ReturnType<typeof validEnv>): readonly string[] {
  const result = tryLoadConfig(env);
  if (result.ok) {
    throw new Error('expected configuration to be rejected');
  }
  return result.issues;
}

function mentionsDemoFixedCode(issues: readonly string[], fragment = ''): boolean {
  return issues.some((issue) => issue.includes(`SUAS_DEMO_FIXED_CODE${fragment}`));
}

describe('SUAS_DEMO_FIXED_CODE', () => {
  it('enables the fixed code for LOCAL when set to enabled', () => {
    const config = loadConfig(validEnv({ SUAS_ENV: 'LOCAL', SUAS_DEMO_FIXED_CODE: 'enabled' }));
    expect(config.environment).toBe('LOCAL');
    expect(config.demoFixedCode).toBe(true);
  });

  it('disables the fixed code for LOCAL when unset', () => {
    const config = loadConfig(validEnv({ SUAS_ENV: 'LOCAL' }));
    expect(config.demoFixedCode).toBe(false);
  });

  it('disables the fixed code for LOCAL when set to disabled', () => {
    const config = loadConfig(validEnv({ SUAS_ENV: 'LOCAL', SUAS_DEMO_FIXED_CODE: 'disabled' }));
    expect(config.demoFixedCode).toBe(false);
  });

  it('rejects enabled outside LOCAL under TEST', () => {
    const issues = issuesFor(validEnv({ SUAS_ENV: 'TEST', SUAS_DEMO_FIXED_CODE: 'enabled' }));
    expect(mentionsDemoFixedCode(issues, '=enabled')).toBe(true);
  });

  it('rejects enabled outside LOCAL under STAGING', () => {
    const issues = issuesFor(
      validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_SESSION_SECRET: 'a'.repeat(48),
        SUAS_DEMO_FIXED_CODE: 'enabled',
      }),
    );
    expect(mentionsDemoFixedCode(issues, '=enabled')).toBe(true);
  });

  it('allows disabled under TEST', () => {
    const config = loadConfig(validEnv({ SUAS_ENV: 'TEST', SUAS_DEMO_FIXED_CODE: 'disabled' }));
    expect(config.environment).toBe('TEST');
    expect(config.demoFixedCode).toBe(false);
  });

  it('is rejected under PRODUCTION', () => {
    const issues = issuesFor(
      validEnv({
        SUAS_ENV: 'PRODUCTION',
        SUAS_SESSION_SECRET: 'a'.repeat(48),
        SUAS_DEMO_FIXED_CODE: 'enabled',
      }),
    );
    expect(mentionsDemoFixedCode(issues)).toBe(true);
  });

  it('rejects values other than enabled or disabled', () => {
    const issues = issuesFor(validEnv({ SUAS_ENV: 'LOCAL', SUAS_DEMO_FIXED_CODE: 'yes' }));
    expect(mentionsDemoFixedCode(issues)).toBe(true);
  });
});
