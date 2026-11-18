/**
 * The staging deploy workflow's gates: an assembly bound to one commit and digest, migration
 * and worker results that must match the build, and refusal of a schema-incompatible rollback.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as Fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  assemblyDigest,
  assemblyStacks,
  checkHealth,
  checkInvocation,
  checkMigration,
  checkSchemaOrder,
  checkWorker,
  drainSeconds,
  invokeTarget,
  parseRelease,
  quiesceDrainSeconds,
  verifyRelease,
  writeRelease,
  type ReleaseRecord,
} from '../../scripts/ci/staging-release.js';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/schema-version.js';
import { SPEC_VERSION } from '../../src/release/pins.js';

// Lets a test run code right after the digest's lstat check, to swap a file for a symlink.
const afterLstat = vi.hoisted(() => ({ hook: undefined as ((path: string) => void) | undefined }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const lstatSync = ((path: string) => {
    const stat = actual.lstatSync(path);
    afterLstat.hook?.(path);
    return stat;
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync, default: { ...actual, lstatSync } };
});

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

  // release.json crosses an artifact hop, so it is read only in the exact shape `write` makes.
  it('reads back a written record and refuses unexpected or injected fields', async () => {
    const release = await writeRelease(assembly(), SHA, ACCOUNT);
    const written: unknown = JSON.parse(JSON.stringify(release));
    expect(parseRelease(written)).toEqual(release);
    type Json = Record<string, unknown>;
    const first = (r: Json, key: string) => (r[key] as Json[])[0]!;
    const bad: Array<(r: Json) => void> = [
      (r) => (r.extra = true),
      (r) => (first(r, 'migrations').sql = 'DROP TABLE x'),
      (r) => (first(r, 'stacks').roleArn = 'arn:aws:iam::1:role/x'),
      (r) => (r.drainSeconds = '135; rm -rf /'),
      (r) => (r.expectedSchemaVersion = String(EXPECTED_SCHEMA_VERSION)),
      (r) => (r.account = ACCOUNT.replace('1', 'x')),
      (r) => (r.assemblyDigest = 'abc'),
      (r) => delete r.specVersion,
    ];
    for (const mutate of bad) {
      const copy = JSON.parse(JSON.stringify(release)) as Json;
      mutate(copy);
      expect(() => parseRelease(JSON.parse(JSON.stringify(copy)))).toThrow(/release record/i);
    }
    const proto = JSON.stringify(release).replace(/^\{/, '{"__proto__":{"drainSeconds":1},');
    expect(() => parseRelease(JSON.parse(proto))).toThrow(/release record/i);
  });

  // The Lambda Web Adapter execs run.sh; an artifact hop that drops the mode breaks the API.
  it('refuses an assembly whose run.sh lost its executable bit', async () => {
    const dir = assembly();
    const release = await writeRelease(dir, SHA, ACCOUNT);
    chmodSync(join(dir, 'asset.abc', 'run.sh'), 0o644);
    expect(() => verifyRelease(release, dir, SHA)).toThrow(/digest/);
  });

  // A link would digest (and ship) whatever it points at outside cdk.out, or loop forever.
  it('refuses an assembly that contains a symlink', () => {
    const outside = mkdtempSync(join(tmpdir(), 'suas-outside-'));
    writeFileSync(join(outside, 'secret'), 'not part of the build');
    const toFile = assembly();
    symlinkSync(join(outside, 'secret'), join(toFile, 'asset.abc', 'linked'));
    expect(() => assemblyDigest(toFile)).toThrow(/symlink/);
    const toDir = assembly();
    symlinkSync(outside, join(toDir, 'asset.dir'));
    expect(() => assemblyDigest(toDir)).toThrow(/symlink/);
  });

  // A file swapped for a symlink after the lstat check must not be followed out of cdk.out.
  it('refuses a file replaced by a symlink after it was checked', () => {
    const outside = mkdtempSync(join(tmpdir(), 'suas-outside-'));
    writeFileSync(join(outside, 'secret'), 'not part of the build');
    const dir = assembly();
    const target = join(dir, 'asset.abc', 'api.mjs');
    afterLstat.hook = (path) => {
      if (path !== target) return;
      afterLstat.hook = undefined;
      rmSync(target);
      symlinkSync(join(outside, 'secret'), target);
    };
    try {
      expect(() => assemblyDigest(dir)).toThrow(/symlink|ELOOP/);
    } finally {
      afterLstat.hook = undefined;
    }
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

  // A tampered deployed template must not hold the runner in `sleep` for hours.
  it('refuses timeouts outside Lambda limits, so the drain never exceeds 915 seconds', () => {
    for (const timeout of [0, 901, 1.5, 86_400]) {
      const deployed = { Resources: { Api: fnResource(timeout, true) } };
      expect(() => quiesceDrainSeconds({ drainSeconds: 135 }, deployed)).toThrow(/Timeout/);
    }
    const intrinsic = { Resources: { Api: fnResource(30, true) } };
    (intrinsic.Resources.Api.Properties as Record<string, unknown>).Timeout = { Ref: 'T' };
    expect(() => drainSeconds(intrinsic)).toThrow(/Timeout/);
    expect(drainSeconds({ Resources: { Api: fnResource(900, true) } })).toBe(915);
    expect(() => quiesceDrainSeconds({ drainSeconds: 86_400 }, BACKEND)).toThrow(/drainSeconds/);
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

  // The migrator's own "environment: STAGING" proves nothing unless the function is the backend's.
  it('invokes only the backend stack function in the release account and region', () => {
    const bound = { account: ACCOUNT } as ReleaseRecord;
    const name = 'Suas-Staging-Backend-MigrateFunction86058513-AbCd1234';
    expect(invokeTarget(bound, 'migrate', name, ACCOUNT)).toBe(
      `arn:aws:lambda:us-west-2:${ACCOUNT}:function:${name}`,
    );
    expect(invokeTarget(bound, 'worker', name.replace('Migrate', 'JobWorker'), ACCOUNT)).toMatch(
      /:function:Suas-Staging-Backend-JobWorkerFunction/,
    );
    for (const other of [
      '',
      'Suas-Staging-Backend-ApiFunctionCE271BD4-AbCd1234',
      'Fake-STAGING-MigrateFunction',
      `${name}:attacker-alias`,
      `arn:aws:lambda:us-west-2:210987654321:function:${name}`,
    ]) {
      expect(() => invokeTarget(bound, 'migrate', other, ACCOUNT)).toThrow(/migrate function/);
    }
    expect(() => invokeTarget(bound, 'migrate', name, '210987654321')).toThrow(/release account/);
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
