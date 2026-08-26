/**
 * CLI for the synthetic privacy deletion drill.
 *
 * Runs only against the LOCAL/TEST synthetic database. Prints a structured
 * JSON report with opaque identifiers and no contact data. Exits non-zero on
 * environment refusal, timeout, or invariant failure.
 *
 * Health / rollback:
 * - Fail closed on PRODUCTION, STAGING, real external effects, or a production
 *   URL marker.
 * - Timeout aborts the run; leftover rows are synthetic UUIDs in the test DB.
 * - There is no automatic purge and no provider-side effect.
 * - Do not point this script at a non-synthetic database.
 */

import { loadConfig } from '../src/config/index.js';
import { createPool } from '../src/db/index.js';
import { runDeletionDrill } from '../src/privacy/deletion-drill.js';
import { testDatabaseUrl, validEnv } from '../tests/helpers/env.js';

async function main(): Promise<void> {
  const config = loadConfig(
    validEnv({
      SUAS_MIGRATIONS_MODE: 'validate',
      DATABASE_URL: testDatabaseUrl(),
    }),
  );
  const pool = createPool(config);
  try {
    const report = await runDeletionDrill(pool, config);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: 'error', error: message }));
  process.exitCode = 1;
});
