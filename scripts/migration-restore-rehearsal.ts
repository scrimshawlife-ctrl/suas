/**
 * Migration + empty-DB apply rehearsal (synthetic).
 *
 * Applies migrations to TEST_MIGRATIONS_DATABASE_URL (separate from the shared
 * suite DB), reports applied version count, and exits non-zero on drift/plan
 * failure. Full filesystem backup restore remains D-024 / ops-owned.
 */

import { loadConfig } from '../src/config/index.js';
import {
  createPool,
  ensureMigrationsTable,
  loadMigrationFiles,
  planMigrations,
  readAppliedMigrations,
  runMigrations,
} from '../src/db/index.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../src/release/pins.js';
import { migrationsTestDatabaseUrl, validEnv } from '../tests/helpers/env.js';

async function main(): Promise<void> {
  const databaseUrl = migrationsTestDatabaseUrl();
  const config = loadConfig(
    validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: databaseUrl,
    }),
  );
  const pool = createPool(config);
  try {
    await ensureMigrationsTable(pool);
    const files = await loadMigrationFiles();
    const appliedBefore = await readAppliedMigrations(pool);
    const plan = planMigrations(files, appliedBefore);
    if (plan.drifted.length > 0 || plan.orphaned.length > 0) {
      throw new Error(
        `unsafe migration state: drifted=${plan.drifted.length} orphaned=${plan.orphaned.length}`,
      );
    }
    console.log(
      JSON.stringify(
        {
          database: 'migrations_test',
          migration_files: files.length,
          already_applied: appliedBefore.length,
          pending: plan.pending.length,
        },
        null,
        2,
      ),
    );
    await runMigrations(pool, {
      mode: 'apply',
      provenance: { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST },
    });
    const appliedAfter = await readAppliedMigrations(pool);
    const postPlan = planMigrations(files, appliedAfter);
    if (postPlan.pending.length !== 0 || postPlan.drifted.length !== 0) {
      throw new Error(
        `drift after apply: pending=${postPlan.pending.length} drifted=${postPlan.drifted.length}`,
      );
    }
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          applied: appliedAfter.length,
          rto_rpo_verdict: 'NOT_COMPUTABLE',
          note: 'D-024 envelopes absent — empty-DB apply rehearsal only',
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
