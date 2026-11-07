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
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const infraRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Drop credential and CDK account selection. Put the metadata and config files out of reach. */
export function offlineSynthEnv(parent) {
  const env = Object.fromEntries(
    Object.entries(parent).filter(([key]) => !key.startsWith('AWS_') && !key.startsWith('CDK_')),
  );
  Object.assign(env, {
    AWS_EC2_METADATA_DISABLED: 'true',
    AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_CONFIG_FILE: '/dev/null',
  });
  return env;
}

/** The aws-cdk package installed by `npm ci`. `npx` is not used: it can download a CLI. */
export function localCdkBin(root = infraRoot) {
  return join(root, 'node_modules', 'aws-cdk', 'bin', 'cdk');
}

/** 1 when the local CLI is absent. Never returns an npx command. */
export function prepareCdkLaunch(root = infraRoot) {
  const cli = localCdkBin(root);
  if (!existsSync(cli)) return { status: 1, command: null };
  return { status: 0, command: [process.execPath, cli] };
}

export function cdkSynthArgs(extra) {
  const givesModel = extra.some(
    (arg) => arg.includes('bedrockModelId=') || arg.includes('allowPlaceholderModel='),
  );
  return [
    'synth',
    '--quiet',
    '--no-lookups',
    '--no-notices',
    '--no-version-reporting',
    ...(givesModel ? [] : ['-c', 'allowPlaceholderModel=true']),
    ...extra,
  ];
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const extra = process.argv.slice(2);
  const launch = prepareCdkLaunch();
  if (launch.status !== 0 || launch.command === null) {
    console.error(
      `aws-cdk CLI is not at ${localCdkBin()}. Run npm ci in infra/. Refusing to fetch a CLI with npx.`,
    );
    process.exit(1);
  }
  const result = spawnSync(launch.command[0], [...launch.command.slice(1), ...cdkSynthArgs(extra)], {
    env: offlineSynthEnv(process.env),
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
