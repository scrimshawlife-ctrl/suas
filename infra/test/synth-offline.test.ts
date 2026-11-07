import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cdkSynthArgs, localCdkBin, offlineSynthEnv, prepareCdkLaunch } from '../scripts/synth.mjs';

describe('offline synth', () => {
  it('drops AWS and CDK credentials and disables instance metadata', () => {
    const env = offlineSynthEnv({
      PATH: '/usr/bin',
      AWS_ACCESS_KEY_ID: 'ASIAFAKE',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_PROFILE: 'staging',
      CDK_DEFAULT_ACCOUNT: '123456789012',
      CDK_DEFAULT_REGION: 'us-west-2',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.CDK_DEFAULT_ACCOUNT).toBeUndefined();
    expect(env.CDK_DEFAULT_REGION).toBeUndefined();
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null');
    expect(env.AWS_CONFIG_FILE).toBe('/dev/null');
  });

  it('passes --no-lookups and does not call npx', () => {
    expect(cdkSynthArgs([])).toEqual([
      'synth',
      '--quiet',
      '--no-lookups',
      '--no-notices',
      '--no-version-reporting',
      '-c',
      'allowPlaceholderModel=true',
    ]);
    expect(cdkSynthArgs(['-c', 'bedrockModelId=example.model-v1:0'])).not.toContain(
      'allowPlaceholderModel=true',
    );
  });

  it('fails when the local aws-cdk binary is absent and does not fall back to npx', () => {
    const root = mkdtempSync(join(tmpdir(), 'suas-no-cdk-'));
    const launch = prepareCdkLaunch(root);
    expect(launch.status).toBe(1);
    expect(launch.command).toBeNull();
    expect(localCdkBin(root)).toMatch(/node_modules\/aws-cdk\/bin\/cdk$/);
    expect(JSON.stringify(launch)).not.toContain('npx');
  });
});
