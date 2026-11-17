/**
 * The staging deploy workflow's gates: an assembly bound to one commit and digest, migration
 * and worker results that must match the build, and refusal of a schema-incompatible rollback.
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assemblyStacks,
  checkHealth,
  checkInvocation,
  checkMigration,
  checkSchemaOrder,
  checkWorker,
  drainSeconds,
  quiesceDrainSeconds,
  verifyRelease,
  writeRelease,
  type ReleaseRecord,
} from '../../scripts/ci/staging-release.js';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/schema-version.js';
import { SPEC_VERSION } from '../../src/release/pins.js';

const ACCOUNT = '123456789012';
const SHA = 'b'.repeat(40);
const stackArtifact = (region: string) => ({
  type: 'aws:cloudformation:stack',
  environment: `aws://${ACCOUNT}/${region}`,
});
const MANIFEST = {
  version: '55.0.0',
  artifacts: {
    'Suas-Dns': stackArtifact('us-west-2'),
    'Suas-Staging-WebCert': stackArtifact('us-east-1'),
    'Suas-Staging-Backend': stackArtifact('us-west-2'),
    'Suas-Staging-Web': stackArtifact('us-west-2'),
    'Suas-Dns.assets': { type: 'cdk:asset-manifest' },
    Tree: { type: 'cdk:tree' },
  },
};

// As synthesized: a mode-throttled function reserves Fn::If(blocked, 0, its own cap or NoValue);
// any other reservation is a fixed cap (lean STAGING caps migrate at 1).
const NO_VALUE = { Ref: 'AWS::NoValue' };
const fnResource = (timeout: number, throttled: boolean, cap?: number) => ({
  Type: 'AWS::Lambda::Function',
  Properties: {
    Timeout: timeout,
    ...(throttled
      ? { ReservedConcurrentExecutions: { 'Fn::If': ['ApiBlocked', 0, cap ?? NO_VALUE] } }
      : cap !== undefined
        ? { ReservedConcurrentExecutions: cap }
        : {}),
  },
});
const BACKEND = {
  Resources: {
    Api: fnResource(30, true, 15),
    Worker: fnResource(120, true),
    Migrate: fnResource(300, false, 1),
  },
};

function assembly(): string {
  const dir = mkdtempSync(join(tmpdir(), 'suas-release-'));
  mkdirSync(join(dir, 'asset.abc'));
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
  writeFileSync(join(dir, 'asset.abc', 'api.mjs'), 'export {};');
  writeFileSync(join(dir, 'asset.abc', 'run.sh'), '#!/bin/bash\n', { mode: 0o755 });
  writeFileSync(join(dir, 'Suas-Staging-Backend.template.json'), JSON.stringify(BACKEND));
  return dir;
}

const migrated = {
  environment: 'STAGING',
  mode: 'apply',
  schema_version: EXPECTED_SCHEMA_VERSION,
  expected_schema_version: EXPECTED_SCHEMA_VERSION,
  applied_now: [],
  spec_stack_drift: false,
};

describe('release record', () => {
  it('binds the commit, pins, migrations and every assembly byte', async () => {
    const dir = assembly();
    const release = await writeRelease(dir, SHA, ACCOUNT);
    expect(release).toMatchObject({ sourceSha: SHA, specVersion: SPEC_VERSION, account: ACCOUNT });
    expect(release.expectedSchemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(release.migrations).toHaveLength(EXPECTED_SCHEMA_VERSION);
    // The mode never throttles the migrator, so its five minutes (and fixed cap) do not count.
    expect(release.drainSeconds).toBe(135);
    expect(() => verifyRelease(release, dir, SHA)).not.toThrow();

    writeFileSync(join(dir, 'asset.abc', 'api.mjs'), 'export const changed = 1;');
    expect(() => verifyRelease(release, dir, SHA)).toThrow(/digest/);
    expect(() => verifyRelease(release, assembly(), 'c'.repeat(40))).toThrow(/another commit/);
  });

  // The Lambda Web Adapter execs run.sh; an artifact hop that drops the mode breaks the API.
  it('refuses an assembly whose run.sh lost its executable bit', async () => {
    const dir = assembly();
    const release = await writeRelease(dir, SHA, ACCOUNT);
    chmodSync(join(dir, 'asset.abc', 'run.sh'), 0o644);
    expect(() => verifyRelease(release, dir, SHA)).toThrow(/digest/);
  });

  it('refuses a backend template without maintenance controls', () => {
    expect(() => drainSeconds({ Resources: { Migrate: fnResource(300, false, 1) } })).toThrow(
      /no maintenance/,
    );
  });

  // In-flight work at quiesce runs on the deployed functions, so their timeouts bound the wait.
  it('drains for the deployed timeouts when they are longer than this build', () => {
    const deployed = { Resources: { Api: fnResource(30, true), Worker: fnResource(600, true) } };
    expect(quiesceDrainSeconds({ drainSeconds: 135 }, deployed)).toBe(615);
    expect(quiesceDrainSeconds({ drainSeconds: 135 }, JSON.stringify(deployed))).toBe(615);
    expect(quiesceDrainSeconds({ drainSeconds: 135 }, BACKEND)).toBe(135);
  });

  it('refuses short SHAs, other accounts and unexpected or account-less stacks', async () => {
    await expect(writeRelease(assembly(), 'main', ACCOUNT)).rejects.toThrow(/40 hex/);
    expect(() => assemblyStacks(MANIFEST, '210987654321')).toThrow(/another account/);
    const extra = { artifacts: { ...MANIFEST.artifacts, Other: stackArtifact('us-west-2') } };
    expect(() => assemblyStacks(extra, ACCOUNT)).toThrow(/Unexpected stacks/);
    const unbound = structuredClone(MANIFEST);
    unbound.artifacts['Suas-Dns'].environment = 'aws://unknown-account/us-west-2';
    expect(() => assemblyStacks(unbound, ACCOUNT)).toThrow(/no concrete account/);
  });

  // staging-deploy.sh reads and quiesces the backend in us-west-2 only.
  it('refuses a stack moved to the other allowed region', () => {
    const moved = structuredClone(MANIFEST);
    moved.artifacts['Suas-Staging-Backend'].environment = `aws://${ACCOUNT}/us-east-1`;
    expect(() => assemblyStacks(moved, ACCOUNT)).toThrow(/must target us-west-2/);
  });
});

describe('deploy result checks', () => {
  const release = { expectedSchemaVersion: EXPECTED_SCHEMA_VERSION } as ReleaseRecord;

  it('accepts a matching migration and rejects each mismatch', () => {
    expect(() => checkMigration(migrated, release)).not.toThrow();
    for (const bad of [
      { environment: 'PRODUCTION' },
      { mode: 'validate' },
      { schema_version: EXPECTED_SCHEMA_VERSION - 1 },
      { expected_schema_version: EXPECTED_SCHEMA_VERSION + 1 },
      { spec_stack_drift: true },
    ]) {
      expect(() => checkMigration({ ...migrated, ...bad }, release)).toThrow(/not verified/);
    }
  });

  it('treats a function error or non-200 invoke as failure', () => {
    expect(() => checkInvocation({ StatusCode: 200 })).not.toThrow();
    expect(() => checkInvocation({ StatusCode: 200, FunctionError: 'Unhandled' })).toThrow();
    expect(() => checkInvocation({ StatusCode: 500 })).toThrow();
  });

  it('requires exactly one worker pass and a durable healthy API', () => {
    expect(() => checkWorker({ passes: 1 })).not.toThrow();
    expect(() => checkWorker({ errorMessage: 'boom' })).toThrow();
    const healthy = { status: 'ok', dependencies: { job_queue: { durability: 'durable' } } };
    expect(() => checkHealth(healthy)).not.toThrow();
    expect(() => checkHealth({ ...healthy, status: 'degraded' })).toThrow();
    expect(() => checkHealth({ status: 'ok', dependencies: {} })).toThrow(/durable/);
  });

  it('refuses older code against a newer deployed schema, allows first deploys', () => {
    expect(() => checkSchemaOrder(release, '')).not.toThrow();
    expect(() => checkSchemaOrder(release, String(EXPECTED_SCHEMA_VERSION))).not.toThrow();
    expect(() => checkSchemaOrder(release, String(EXPECTED_SCHEMA_VERSION - 1))).not.toThrow();
    expect(() => checkSchemaOrder(release, String(EXPECTED_SCHEMA_VERSION + 1))).toThrow(
      /repair forward/,
    );
    expect(() => checkSchemaOrder(release, 'abc')).toThrow(/Unreadable/);
  });
});
