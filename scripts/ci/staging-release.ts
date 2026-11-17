/**
 * Release record and result checks for .github/workflows/staging-deploy.yml.
 *
 * `write` binds one source SHA to the exact synthesized assembly (every file digested) plus the
 * spec pin, expected schema and migration checksums; `verify` re-digests before deploying. The
 * `check-*` commands turn Lambda and health responses into pass/fail so the shell never parses
 * JSON. No secrets are read or printed: invocation payloads carry no configuration.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadMigrationFiles } from '../../src/db/migration-files.js';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/schema-version.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

/** Each stack and the one region it lives in (CloudFront certificates are us-east-1 only). */
export const STACK_REGIONS = {
  'Suas-Dns': 'us-west-2',
  'Suas-Staging-WebCert': 'us-east-1',
  'Suas-Staging-Backend': 'us-west-2',
  'Suas-Staging-Web': 'us-west-2',
} as const;

export interface ReleaseRecord {
  readonly formatVersion: 1;
  readonly sourceSha: string;
  readonly specVersion: string;
  readonly releaseManifest: string;
  readonly expectedSchemaVersion: number;
  readonly migrations: ReadonlyArray<{ readonly fileName: string; readonly checksum: string }>;
  readonly account: string;
  readonly stacks: ReadonlyArray<{ readonly id: string; readonly environment: string }>;
  readonly assemblyDigest: string;
  /** This build's longest throttled function timeout plus margin; the floor of the drain. */
  readonly drainSeconds: number;
}

/**
 * One digest over every file path, executable bit and content, so any changed byte or a lost
 * exec mode (the Lambda Web Adapter execs run.sh) changes it.
 */
export function assemblyDigest(dir: string): string {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(dir);
  const hash = createHash('sha256');
  for (const file of files) {
    const executable = (statSync(file).mode & 0o111) !== 0 ? 'x' : '-';
    hash.update(relative(dir, file)).update('\0').update(executable).update('\0');
    hash.update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

/** The stacks of the assembly, refusing anything the pipeline does not deploy. */
export function assemblyStacks(
  manifest: unknown,
  account: string,
): Array<{ id: string; environment: string }> {
  const artifacts = (
    manifest as { artifacts?: Record<string, { type: string; environment?: string }> }
  ).artifacts;
  if (artifacts === undefined) throw new Error('cdk.out/manifest.json has no artifacts.');
  const stacks = Object.entries(artifacts)
    .filter(([, artifact]) => artifact.type === 'aws:cloudformation:stack')
    .map(([id, artifact]) => ({ id, environment: artifact.environment ?? '' }));
  const ids = stacks.map((s) => s.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(Object.keys(STACK_REGIONS).sort())) {
    throw new Error(`Unexpected stacks in the assembly: ${ids.join(', ')}`);
  }
  for (const stack of stacks) {
    if (!/^aws:\/\/\d{12}\/us-(west-2|east-1)$/.test(stack.environment)) {
      throw new Error(`${stack.id} has no concrete account/region: ${stack.environment}`);
    }
    if (!stack.environment.startsWith(`aws://${account}/`)) {
      throw new Error(`${stack.id} targets another account.`);
    }
    const region = STACK_REGIONS[stack.id as keyof typeof STACK_REGIONS];
    if (!stack.environment.endsWith(`/${region}`)) {
      throw new Error(`${stack.id} must target ${region}.`);
    }
  }
  return stacks;
}

/** Longest timeout among functions the maintenance mode throttles, from the backend template. */
export function drainSeconds(template: unknown): number {
  const resources = Object.values(
    (
      template as {
        Resources?: Record<string, { Type: string; Properties?: Record<string, unknown> }>;
      }
    ).Resources ?? {},
  );
  const timeouts = resources
    .filter(
      (r) =>
        r.Type === 'AWS::Lambda::Function' &&
        r.Properties?.ReservedConcurrentExecutions !== undefined,
    )
    .map((r) => Number(r.Properties?.Timeout ?? 3));
  if (timeouts.length === 0)
    throw new Error('Backend template has no maintenance-controlled functions.');
  return Math.max(...timeouts) + 15;
}

/**
 * The wait after quiesce. In-flight invocations run on the deployed functions, whose timeouts
 * can be longer than this build's, so the deployed template (an object, or the JSON string
 * `get-template` may return) sets the wait; it is never shorter than the release records.
 */
export function quiesceDrainSeconds(
  release: Pick<ReleaseRecord, 'drainSeconds'>,
  deployedTemplate: unknown,
): number {
  const template: unknown =
    typeof deployedTemplate === 'string' ? JSON.parse(deployedTemplate) : deployedTemplate;
  return Math.max(release.drainSeconds, drainSeconds(template));
}

export async function writeRelease(
  cdkOut: string,
  sourceSha: string,
  account: string,
): Promise<ReleaseRecord> {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) throw new Error('Source SHA must be 40 hex characters.');
  if (!/^\d{12}$/.test(account)) throw new Error('Account must be 12 digits.');
  const manifest: unknown = JSON.parse(readFileSync(join(cdkOut, 'manifest.json'), 'utf8'));
  const migrations = await loadMigrationFiles();
  return {
    formatVersion: 1,
    sourceSha,
    specVersion: SPEC_VERSION,
    releaseManifest: RELEASE_MANIFEST,
    expectedSchemaVersion: EXPECTED_SCHEMA_VERSION,
    migrations: migrations.map(({ fileName, checksum }) => ({ fileName, checksum })),
    account,
    stacks: assemblyStacks(manifest, account),
    assemblyDigest: assemblyDigest(cdkOut),
    drainSeconds: drainSeconds(readJson(join(cdkOut, 'Suas-Staging-Backend.template.json'))),
  };
}

export function verifyRelease(release: ReleaseRecord, cdkOut: string, sourceSha: string): void {
  if (release.formatVersion !== 1) throw new Error('Unknown release record format.');
  if (release.sourceSha !== sourceSha) throw new Error('Release record is for another commit.');
  if (assemblyDigest(cdkOut) !== release.assemblyDigest) {
    throw new Error('cdk.out does not match the digest recorded at build time.');
  }
}

/** Refuses a backend whose schema expectation is older than what is already deployed. */
export function checkSchemaOrder(release: ReleaseRecord, deployedOutput: string): void {
  if (deployedOutput === '' || deployedOutput === 'None') return; // first pipeline deploy
  const deployed = Number(deployedOutput);
  if (!Number.isInteger(deployed))
    throw new Error(`Unreadable deployed schema "${deployedOutput}".`);
  if (deployed > release.expectedSchemaVersion) {
    throw new Error(
      `Deployed schema ${deployed} is newer than this build expects (${release.expectedSchemaVersion}). ` +
        'Older code refuses a newer schema: repair forward instead of rolling back.',
    );
  }
}

/** `aws lambda invoke` metadata plus body: any FunctionError or non-200 is a failure. */
export function checkInvocation(metadata: unknown): void {
  const meta = metadata as { StatusCode?: number; FunctionError?: string };
  if (meta.FunctionError !== undefined) throw new Error(`Function error: ${meta.FunctionError}.`);
  if (meta.StatusCode !== 200)
    throw new Error(`Unexpected invoke status ${String(meta.StatusCode)}.`);
}

export function checkMigration(body: unknown, release: ReleaseRecord): void {
  const r = body as Record<string, unknown>;
  const problems = [
    r.environment !== 'STAGING' && `environment=${String(r.environment)}`,
    r.mode !== 'apply' && `mode=${String(r.mode)}`,
    r.expected_schema_version !== release.expectedSchemaVersion &&
      `expected_schema_version=${String(r.expected_schema_version)} (build ${release.expectedSchemaVersion})`,
    r.schema_version !== release.expectedSchemaVersion &&
      `schema_version=${String(r.schema_version)}`,
    r.spec_stack_drift !== false && 'spec_stack_drift is not false',
  ].filter((p): p is string => typeof p === 'string');
  if (problems.length > 0) throw new Error(`Migration not verified: ${problems.join('; ')}.`);
}

export function checkWorker(body: unknown): void {
  if (JSON.stringify(body) !== JSON.stringify({ passes: 1 })) {
    throw new Error(`Worker returned ${JSON.stringify(body)}, expected {"passes":1}.`);
  }
}

/** Health is configuration posture only; the DB-backed checks come from migrate and e2e. */
export function checkHealth(body: unknown): void {
  const h = body as {
    status?: string;
    dependencies?: { job_queue?: { durability?: string } };
  };
  if (h.status !== 'ok') throw new Error(`Health status is ${String(h.status)}.`);
  if (h.dependencies?.job_queue?.durability !== 'durable') {
    throw new Error('Health does not report a durable job queue.');
  }
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...args] = argv;
  const sha = process.env.SUAS_BUILD_COMMIT ?? '';
  switch (command) {
    case 'write': {
      const [cdkOut, out] = args as [string, string];
      const release = await writeRelease(cdkOut, sha, process.env.CDK_DEFAULT_ACCOUNT ?? '');
      writeFileSync(out, `${JSON.stringify(release, null, 2)}\n`);
      return;
    }
    case 'verify':
      return verifyRelease(readJson(args[1]!) as ReleaseRecord, args[0]!, sha);
    case 'check-schema-order':
      return checkSchemaOrder(readJson(args[0]!) as ReleaseRecord, args[1] ?? '');
    case 'check-migration':
      checkInvocation(readJson(args[1]!));
      return checkMigration(readJson(args[0]!), readJson(args[2]!) as ReleaseRecord);
    case 'check-worker':
      checkInvocation(readJson(args[1]!));
      return checkWorker(readJson(args[0]!));
    case 'check-health':
      return checkHealth(readJson(args[0]!));
    case 'drain':
      console.log(quiesceDrainSeconds(readJson(args[0]!) as ReleaseRecord, readJson(args[1]!)));
      return;
    case 'field': {
      // Prints one top-level field of a release record for the shell.
      const value = (readJson(args[0]!) as Record<string, unknown>)[args[1]!];
      if (value === undefined) throw new Error(`Release record has no field "${String(args[1])}".`);
      console.log(typeof value === 'string' ? value : JSON.stringify(value));
      return;
    }
    default:
      throw new Error(`Unknown command "${String(command)}".`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
