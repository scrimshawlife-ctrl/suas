/**
 * scripts/ci/staging-deploy.sh against a fake AWS CLI and a fake CDK CLI: a failed stack read,
 * incomplete or wrong CDK deploy role credentials, a migrate function that is not the backend's,
 * or a web-only deploy over a mismatched schema must stop the deploy before the step it guards.
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
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const SHA = 'a'.repeat(40);
const ACCOUNT = '123456789012';
const DEPLOY_ROLE = `cdk-hnb659fds-deploy-role-${ACCOUNT}-us-west-2`;
const MIGRATE = 'Suas-Staging-Backend-MigrateFunction86058513-AbCd1234';

// The fake aws answers by query. API_LOOKUP: missing = no backend stack yet; expired = the API
// function name read fails; deployed = the backend exists. CREDS is what assume-role prints, and
// the identity it then reports is ASSUMED_ARN for those keys, the caller's otherwise.
const FAKE_AWS = `#!/usr/bin/env bash
echo "$*" >>"$AWS_LOG"
missing() { echo "An error occurred (ValidationError): Stack with id X does not exist" >&2; exit 254; }
case "$*" in
  "sts get-caller-identity --query Account"*) echo "${ACCOUNT}" ;;
  "sts get-caller-identity --query Arn"*)
    if [ "$AWS_ACCESS_KEY_ID" = ASIAKEY ]; then echo "$ASSUMED_ARN"
    else echo "arn:aws:sts::${ACCOUNT}:assumed-role/suas-gha-staging-deploy/caller"; fi ;;
  "sts assume-role"*) printf '%s\\n' "$CREDS" ;;
  *StackStatus*) echo "\${STACK_STATUS:-UPDATE_COMPLETE}" ;;
  *ExpectedSchemaVersion*) [ "$API_LOOKUP" = missing ] && missing; echo "$SCHEMA" ;;
  *ApiFunctionName*)
    [ "$API_LOOKUP" = missing ] && missing
    [ "$API_LOOKUP" = deployed ] && { echo Suas-Staging-Backend-ApiFunction-x; exit 0; }
    echo "An error occurred (ExpiredToken): The security token is expired" >&2; exit 254 ;;
  *MigrateFunctionName*) echo "$MIGRATE_NAME" ;;
  *JobWorkerFunctionName*) echo Suas-Staging-Backend-JobWorkerFunction12345678-AbCd1234 ;;
  *DeploymentMode*) cat "$MODE_FILE" ;;
  *'Parameters[].ParameterKey'*) echo '["DeploymentMode", "AlarmEmail"]' ;;
  *RoleARN*) echo "arn:aws:iam::${ACCOUNT}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT}-us-west-2" ;;
  "cloudformation update-stack"*)
    [ "$RECOVERY_FAIL" = true ] && exit 31
    echo maintenance >"$MODE_FILE" ;;
  "cloudformation wait"*) [ "$RECOVERY_FAIL" != wait ] ;;
  "sns publish"*) exit 0 ;;
  "lambda invoke"*)
    case "$*" in
      *Migrate*) printf '{"environment":"STAGING","mode":"apply","expected_schema_version":%s,"schema_version":%s,"spec_stack_drift":false}' "$SCHEMA" "$SCHEMA" >"\${@: -1}" ;;
      *) echo '{"passes":1}' >"\${@: -1}" ;;
    esac
    echo '{"StatusCode":200}' ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;

// Records every CDK call and exits with CDK_STATUS (failing by default), so no test reaches a
// real deploy.
const FAKE_CDK = `require('fs').appendFileSync(process.env.CDK_LOG, process.argv.slice(2).join(' ') + '\\n');
const mode = process.argv.find(a => a.startsWith('Suas-Staging-Backend:DeploymentMode='))?.split('=')[1];
if (mode) require('fs').writeFileSync(process.env.MODE_FILE, mode);
const stage = mode ?? 'web';
process.exit(stage === process.env.FAIL_STAGE ? 23 : Number(process.env.CDK_STATUS ?? 1));
`;

interface Scenario {
  apiLookup: 'missing' | 'expired' | 'deployed';
  scope?: 'full' | 'web';
  schema?: number;
  creds?: string;
  assumedArn?: string;
  cdkStatus?: number;
  migrateName?: string;
  failStage?: string;
  recoveryFail?: string;
  stackStatus?: string;
}

function runDeploy(scenario: Scenario) {
  const work = mkdtempSync(join(tmpdir(), 'suas-deploy-script-'));
  for (const link of ['scripts', 'src', 'node_modules']) {
    symlinkSync(join(ROOT, link), join(work, link));
  }
  mkdirSync(join(work, 'bin'));
  writeFileSync(join(work, 'mode'), 'maintenance');
  writeFileSync(
    join(work, 'bin', 'curl'),
    `#!/usr/bin/env bash
[ "$FAIL_STAGE" = health ] && exit 23
echo '{"status":"ok","dependencies":{"job_queue":{"durability":"durable"}}}'
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(work, 'bin', 'npm'),
    `#!/usr/bin/env bash
echo "$*" >>"$PUBLIC_LOG"
[ "$FAIL_STAGE" = public ] && exit 23
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(join(work, 'bin', 'aws'), FAKE_AWS, { mode: 0o755 });
  mkdirSync(join(work, 'infra/node_modules/aws-cdk/bin'), { recursive: true });
  writeFileSync(join(work, 'infra/node_modules/aws-cdk/bin/cdk'), FAKE_CDK);
  mkdirSync(join(work, 'cdk.out'));
  writeFileSync(join(work, 'cdk.out', 'manifest.json'), '{}');
  const release = {
    formatVersion: 1,
    sourceSha: SHA,
    specVersion: SPEC_VERSION,
    releaseManifest: RELEASE_MANIFEST,
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    migrations: [],
    account: ACCOUNT,
    stacks: [],
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
      SUAS_STAGING_ALARM_EMAIL: 'operator@example.invalid',
      API_ORIGIN: 'https://api.example.invalid',
      GITHUB_RUN_ID: '42',
      SCOPE: scenario.scope ?? 'full',
      API_LOOKUP: scenario.apiLookup,
      SCHEMA: String(scenario.schema ?? EXPECTED_SCHEMA_VERSION),
      CREDS: scenario.creds ?? '',
      ASSUMED_ARN: scenario.assumedArn ?? '',
      CDK_STATUS: String(scenario.cdkStatus ?? 1),
      MIGRATE_NAME: scenario.migrateName ?? MIGRATE,
      AWS_LOG: join(work, 'aws.log'),
      MODE_FILE: join(work, 'mode'),
      PUBLIC_LOG: join(work, 'public.log'),
      GITHUB_STEP_SUMMARY: join(work, 'summary'),
      FAIL_STAGE: scenario.failStage ?? '',
      RECOVERY_FAIL: scenario.recoveryFail ?? '',
      STACK_STATUS: scenario.stackStatus ?? 'UPDATE_COMPLETE',
      CDK_LOG: join(work, 'cdk.log'),
    },
  });
  const log = (name: string) =>
    existsSync(join(work, name)) ? readFileSync(join(work, name), 'utf8') : '';
  return {
    ...result,
    cdkCalls: log('cdk.log'),
    awsCalls: log('aws.log'),
    mode: log('mode'),
    summary: log('summary'),
    publicCalls: log('public.log'),
  };
}

describe('staging-deploy.sh', () => {
  // A swallowed read error used to skip quiesce and drain, deploying over live traffic.
  it('stops before any deploy when the deployed backend cannot be read', () => {
    const result = runDeploy({ apiLookup: 'expired' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ExpiredToken');
    expect(result.cdkCalls).toBe('');
  });

  it('skips quiesce and deploys in maintenance when the backend does not exist yet', () => {
    const result = runDeploy({ apiLookup: 'missing' });
    expect(result.cdkCalls).toContain('deploy Suas-Staging-Backend');
    expect(result.cdkCalls).toContain('DeploymentMode=maintenance');
  });

  // Empty or partial keys would leave the CLI on the caller's own identity.
  it.each([
    ['empty', ''],
    ['partial', 'ASIAKEY secret'],
    ['None', 'ASIAKEY secret None'],
  ])('fails closed on %s CDK deploy role credentials', (_, creds) => {
    const result = runDeploy({ apiLookup: 'deployed', creds });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/no complete credentials/);
    expect(result.awsCalls).not.toContain('get-template');
    expect(result.cdkCalls).toBe('');
  });

  it('refuses credentials that are not the CDK deploy role', () => {
    const result = runDeploy({
      apiLookup: 'deployed',
      creds: 'ASIAKEY secret token',
      assumedArn: `arn:aws:sts::${ACCOUNT}:assumed-role/suas-gha-staging-deploy/caller`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/not the CDK deploy role/);
    expect(result.awsCalls).not.toContain('get-template');
    expect(result.cdkCalls).toBe('');
  });

  it('reads the deployed template as the verified CDK deploy role', () => {
    const result = runDeploy({
      apiLookup: 'deployed',
      creds: 'ASIAKEY secret token',
      assumedArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${DEPLOY_ROLE}/suas-quiesce-42`,
    });
    expect(result.awsCalls).toContain('cloudformation get-template');
  });

  // The migrator reports environment STAGING itself; only the invoked ARN proves which ran.
  it('invokes migrate by the backend function ARN and refuses any other function', () => {
    const ok = runDeploy({ apiLookup: 'missing', cdkStatus: 0 });
    expect(ok.awsCalls).toContain(
      `lambda invoke --region us-west-2 --function-name arn:aws:lambda:us-west-2:${ACCOUNT}:function:${MIGRATE}`,
    );
    const other = runDeploy({ apiLookup: 'missing', cdkStatus: 0, migrateName: 'Fake-Migrate' });
    expect(other.status).not.toBe(0);
    expect(other.stderr).toMatch(/not the backend's migrate function/);
    expect(other.awsCalls).not.toContain('lambda invoke');
  });

  it('refuses a web-only deploy when the deployed schema differs from the build', () => {
    const result = runDeploy({
      apiLookup: 'deployed',
      scope: 'web',
      schema: EXPECTED_SCHEMA_VERSION - 1,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Web-only deploy needs/);
    expect(result.cdkCalls).toBe('');
  });
});

describe('deployment failure recovery', () => {
  const admitted = {
    apiLookup: 'missing' as const,
    cdkStatus: 0,
    creds: 'ASIAKEY secret token',
    assumedArn: `arn:aws:sts::${ACCOUNT}:assumed-role/${DEPLOY_ROLE}/suas-quiesce-42`,
  };
  it.each(['maintenance', 'api', 'health', 'worker', 'live', 'web', 'public'])(
    'recovers after %s failure and preserves its exit status',
    (failStage) => {
      const result = runDeploy({ ...admitted, failStage });
      expect(result.status, result.stderr).toBe(23);
      expect(result.mode.trim()).toBe('maintenance');
      expect(result.summary).toContain('Recovery state: maintenance');
      expect(result.awsCalls).toContain('sns publish');
      if (failStage !== 'public') expect(result.publicCalls).toBe('');
      if (['maintenance', 'api', 'health', 'worker'].includes(failStage)) {
        expect(result.cdkCalls).not.toContain('DeploymentMode=live');
      }
    },
  );
  it.each(['true', 'wait'])('reports UNKNOWN when recovery fails (%s)', (recoveryFail) => {
    const result = runDeploy({ ...admitted, failStage: 'public', recoveryFail });
    expect(result.status).toBe(23);
    expect(result.summary).toContain('Recovery state: UNKNOWN');
    expect(result.summary).not.toContain('Recovery state: maintenance');
    expect(result.awsCalls).toContain('sns publish');
  });
  it('does not report maintenance while a stack update is still in progress', () => {
    const result = runDeploy({
      ...admitted,
      failStage: 'public',
      stackStatus: 'UPDATE_IN_PROGRESS',
    });
    expect(result.summary).toContain('Recovery state: UNKNOWN');
  });
  it('does not change a successful deployment or send a failure notification', () => {
    const result = runDeploy(admitted);
    expect(result.status, result.stderr).toBe(0);
    expect(result.mode.trim()).toBe('live');
    expect(result.awsCalls).not.toContain('sns publish');
  });
  it('does not mutate or send notifications after a preflight failure', () => {
    const result = runDeploy({ ...admitted, apiLookup: 'expired' });
    expect(result.cdkCalls).toBe('');
    expect(result.awsCalls).not.toContain('update-stack');
    expect(result.awsCalls).not.toContain('sns publish');
  });
});
