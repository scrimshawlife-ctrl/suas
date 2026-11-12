/**
 * AWS Lambda entry that applies database migrations (V1_PROJECT_PLAN.md §4.1 Migrations).
 *
 * A human invokes it after a deploy; nothing runs it automatically. It is the
 * `migrate apply` command: the same `runMigrations` the CLI uses, in `apply` mode,
 * ignoring SUAS_MIGRATIONS_MODE. It must be configured with a DATABASE_URL that reaches
 * the database directly, not through RDS Proxy, because the migrator holds a session
 * advisory lock. Any failure throws so the invocation errors. The result carries
 * versions only, never connection details.
 *
 * `{"action": "seed-staging-fixtures", "fixtures": [...]}` runs the STAGING fixture seed
 * instead (R11.5, src/staging/fixture-seed.ts). The database is in isolated subnets, and
 * this is the operator's one way into it.
 */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { runMigrations } from '../db/migrator.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../release/pins.js';
import { seedStagingFixtures, type StagingFixtureSeedResult } from '../staging/fixture-seed.js';

export interface MigrateLambdaEvent {
  /** `migrate` (the default) or `seed-staging-fixtures`. */
  readonly action?: string;
  /** Seed only: `[{ "user_id": "<registry user id>", "email": "<synthetic address>" }]`. */
  readonly fixtures?: unknown;
}

export interface MigrateLambdaResult {
  readonly mode: 'apply';
  readonly environment: string;
  readonly schema_version: number | null;
  readonly expected_schema_version: number;
  readonly applied_now: unknown;
  readonly spec_stack_drift: boolean;
}

export interface SeedLambdaResult extends StagingFixtureSeedResult {
  readonly action: 'seed-staging-fixtures';
  readonly environment: string;
}

export async function handler(
  event: MigrateLambdaEvent = {},
): Promise<MigrateLambdaResult | SeedLambdaResult> {
  const action = event.action ?? 'migrate';
  if (action !== 'migrate' && action !== 'seed-staging-fixtures') {
    throw new Error('Unknown action. Use "migrate" or "seed-staging-fixtures".');
  }
  const config = loadConfig(process.env);
  const pool = createPool(config, 'node');
  try {
    if (action === 'seed-staging-fixtures') {
      const seeded = await seedStagingFixtures(pool, config, event.fixtures);
      return { action, environment: config.environment, ...seeded };
    }
    const result = await runMigrations(pool, {
      mode: 'apply',
      provenance: { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST },
    });
    return {
      mode: 'apply',
      environment: config.environment,
      schema_version: result.schemaVersion,
      expected_schema_version: result.expectedSchemaVersion,
      applied_now: result.appliedNow,
      spec_stack_drift: result.specStackDrift,
    };
  } finally {
    await pool.end();
  }
}
