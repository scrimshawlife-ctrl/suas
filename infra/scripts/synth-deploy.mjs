#!/usr/bin/env node
/**
 * Account-bound synth for the staging deploy workflow. Same offline guarantees as synth.mjs
 * (no credentials, no lookups, the lockfile CLI), plus the target account, the pipeline
 * maintenance controls and the build commit. Refuses to run without a staging web build.
 *
 * Usage: CDK_DEFAULT_ACCOUNT=<12 digits> SUAS_BUILD_COMMIT=<sha> npm run synth:deploy
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cdkSynthArgs, localCdkBin, offlineSynthEnv, prepareCdkLaunch } from './synth.mjs';

const infraRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Validates inputs and returns the synth environment and args, or throws with the reason. */
export function deploySynthPlan(
  parent,
  webIndex = join(infraRoot, '..', 'web', 'dist', 'index.html'),
) {
  const account = parent.CDK_DEFAULT_ACCOUNT ?? '';
  if (!/^\d{12}$/.test(account))
    throw new Error('CDK_DEFAULT_ACCOUNT must be a 12-digit AWS account id.');
  const commit = parent.SUAS_BUILD_COMMIT ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error('SUAS_BUILD_COMMIT must be a full 40-character commit SHA.');
  if (!existsSync(webIndex)) {
    throw new Error(
      'web/dist/index.html is missing. Build the web app with VITE_SUAS_API_BASE_URL first.',
    );
  }
  const env = {
    ...offlineSynthEnv(parent),
    CDK_DEFAULT_ACCOUNT: account,
    SUAS_BUILD_COMMIT: commit,
  };
  const args = cdkSynthArgs(['-c', 'deploymentPipeline=true', '-c', `buildCommit=${commit}`]);
  return { env, args };
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let plan;
  try {
    plan = deploySynthPlan(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const launch = prepareCdkLaunch();
  if (launch.status !== 0 || launch.command === null) {
    console.error(`aws-cdk CLI is not at ${localCdkBin()}. Run npm ci in infra/.`);
    process.exit(1);
  }
  const result = spawnSync(launch.command[0], [...launch.command.slice(1), ...plan.args], {
    env: plan.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}
