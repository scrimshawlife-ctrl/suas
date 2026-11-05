/**
 * AWS Lambda entry that applies database migrations (V1_PROJECT_PLAN.md §4.1 Migrations).
 *
 * A human invokes it after a deploy; nothing runs it automatically. It is the
 * `migrate apply` command: the same `runMigrations` the CLI uses, in `apply` mode,
 * ignoring SUAS_MIGRATIONS_MODE. It must be configured with a DATABASE_URL that reaches
 * the database directly, not through RDS Proxy, because the migrator holds a session
 * advisory lock. Any failure throws so the invocation errors. The result carries
 * versions only, never connection details.
 */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { runMigrations } from '../db/migrator.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../release/pins.js';

export interface MigrateLambdaResult {
  readonly mode: 'apply';
  readonly environment: string;
  readonly schema_version: number | null;
  readonly expected_schema_version: number;
  readonly applied_now: unknown;
  readonly spec_stack_drift: boolean;
}

export async function handler(): Promise<MigrateLambdaResult> {
  const config = loadConfig(process.env);
  const pool = createPool(config, 'node');
  try {
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
