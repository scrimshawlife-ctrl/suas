#!/usr/bin/env node
/**
 * Runs `cdk synth` fully offline.
 *
 * The environment is scrubbed of every AWS_* and CDK_* variable (so no credentials,
 * profile or default account can be picked up), the instance metadata service and the
 * shared config files are disabled, lookups are refused, and the CLI notices and telemetry
 * are off. If anything tried to read from AWS, the synth would fail instead of calling it.
 *
 * Usage: npm run synth [-- extra cdk args, such as -c bedrockModelId=<id>]
 * With no bedrockModelId given, the placeholder context is added: that output is only for
 * checking the app, never for deploying.
 */

import { spawnSync } from 'node:child_process';

const extra = process.argv.slice(2);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('AWS_') && !key.startsWith('CDK_')),
);
Object.assign(env, {
  AWS_EC2_METADATA_DISABLED: 'true',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_CONFIG_FILE: '/dev/null',
});

const givesModel = extra.some(
  (arg) => arg.includes('bedrockModelId=') || arg.includes('allowPlaceholderModel='),
);
const args = [
  'cdk',
  'synth',
  '--quiet',
  '--no-lookups',
  '--no-notices',
  '--no-version-reporting',
  ...(givesModel ? [] : ['-c', 'allowPlaceholderModel=true']),
  ...extra,
];
const result = spawnSync('npx', args, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
