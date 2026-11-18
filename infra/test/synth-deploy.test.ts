import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deploySynthPlan } from '../scripts/synth-deploy.mjs';

// The deploy synth binds one account and commit but must stay credential-free and lookup-free.
const dir = mkdtempSync(join(tmpdir(), 'suas-synth-deploy-'));
const webIndex = join(dir, 'index.html');
writeFileSync(webIndex, '<!doctype html>');
const SHA = 'a'.repeat(40);
const parent = {
  PATH: '/usr/bin',
  AWS_ACCESS_KEY_ID: 'ASIAFAKE',
  AWS_PROFILE: 'zerostate',
  CDK_DEFAULT_REGION: 'us-east-1',
  CDK_DEFAULT_ACCOUNT: '123456789012',
  SUAS_BUILD_COMMIT: SHA,
};

describe('deploy synth', () => {
  it('keeps only the account, the commit and the offline guards', () => {
    const { env, args } = deploySynthPlan(parent, webIndex);
    expect(env).toMatchObject({ PATH: '/usr/bin', CDK_DEFAULT_ACCOUNT: '123456789012' });
    expect(env.SUAS_BUILD_COMMIT).toBe(SHA);
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.CDK_DEFAULT_REGION).toBeUndefined();
    expect(env.AWS_CONFIG_FILE).toBe('/dev/null');
    expect(args).toContain('--no-lookups');
    expect(args).toEqual(expect.arrayContaining(['deploymentPipeline=true', `buildCommit=${SHA}`]));
  });

  it.each([
    [{ CDK_DEFAULT_ACCOUNT: undefined }, /12-digit/],
    [{ CDK_DEFAULT_ACCOUNT: '1234' }, /12-digit/],
    [{ SUAS_BUILD_COMMIT: 'main' }, /40-character/],
    [{ SUAS_BUILD_COMMIT: 'A'.repeat(40) }, /40-character/],
  ])('refuses %o', (override, message) => {
    expect(() => deploySynthPlan({ ...parent, ...override }, webIndex)).toThrow(message);
  });

  it('refuses without a web build', () => {
    expect(() => deploySynthPlan(parent, join(dir, 'missing.html'))).toThrow(/web\/dist/);
  });
});
