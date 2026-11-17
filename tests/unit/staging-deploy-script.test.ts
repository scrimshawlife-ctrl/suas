/**
 * scripts/ci/staging-deploy.sh against a fake AWS CLI and a fake CDK CLI: a failed stack read
 * must stop the deploy before anything changes, while a first deploy (no stack yet) proceeds.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assemblyDigest } from '../../scripts/ci/staging-release.js';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/schema-version.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SHA = 'a'.repeat(40);

// The fake aws answers by query. missing: no backend stack yet. expired: the schema read succeeds,
// then the API function name read fails.
const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >>"$AWS_LOG"
missing() { echo "An error occurred (ValidationError): Stack with id X does not exist" >&2; exit 254; }
case "$*" in
  *StackStatus*) echo UPDATE_COMPLETE ;;
  *ExpectedSchemaVersion*) [ "$API_LOOKUP" = missing ] && missing; echo "$SCHEMA" ;;
  *ApiFunctionName*)
    [ "$API_LOOKUP" = missing ] && missing
    echo "An error occurred (ExpiredToken): The security token is expired" >&2; exit 254 ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

// Records every CDK call and fails it, so no test can reach a real deploy.
const FAKE_CDK = `require('fs').appendFileSync(process.env.CDK_LOG, process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`;

function runDeploy(apiLookup: 'missing' | 'expired') {
  const work = mkdtempSync(join(tmpdir(), 'suas-deploy-script-'));
  for (const link of ['scripts', 'src', 'node_modules']) {
    symlinkSync(join(ROOT, link), join(work, link));
  }
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'bin', 'aws'), FAKE_AWS, { mode: 0o755 });
  mkdirSync(join(work, 'infra/node_modules/aws-cdk/bin'), { recursive: true });
  writeFileSync(join(work, 'infra/node_modules/aws-cdk/bin/cdk'), FAKE_CDK);
  mkdirSync(join(work, 'cdk.out'));
  writeFileSync(join(work, 'cdk.out', 'manifest.json'), '{}');
  const release = {
    formatVersion: 1,
    sourceSha: SHA,
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    assemblyDigest: assemblyDigest(join(work, 'cdk.out')),
    drainSeconds: 135,
  };
  writeFileSync(join(work, 'release.json'), JSON.stringify(release));

  const result = spawnSync('bash', [join(ROOT, 'scripts/ci/staging-deploy.sh')], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${join(work, 'bin')}:${process.env.PATH ?? ''}`,
      CDK_OUT: 'cdk.out',
      RELEASE_JSON: 'release.json',
      SUAS_BUILD_COMMIT: SHA,
      API_ORIGIN: 'https://api.example.invalid',
      SCOPE: 'full',
      API_LOOKUP: apiLookup,
      SCHEMA: String(EXPECTED_SCHEMA_VERSION),
      AWS_LOG: join(work, 'aws.log'),
      CDK_LOG: join(work, 'cdk.log'),
    },
  });
  const cdkLog = join(work, 'cdk.log');
  return { ...result, cdkCalls: existsSync(cdkLog) ? readFileSync(cdkLog, 'utf8') : '' };
}

describe('staging-deploy.sh', () => {
  // A swallowed read error used to skip quiesce and drain, deploying over live traffic.
  it('stops before any deploy when the deployed backend cannot be read', () => {
    const result = runDeploy('expired');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ExpiredToken');
    expect(result.cdkCalls).toBe('');
  });

  it('skips quiesce and deploys in maintenance when the backend does not exist yet', () => {
    const result = runDeploy('missing');
    expect(result.cdkCalls).toContain('deploy Suas-Staging-Backend');
    expect(result.cdkCalls).toContain('DeploymentMode=maintenance');
  });
});
