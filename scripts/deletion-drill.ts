/**
 * CLI for the synthetic privacy deletion drill.
 *
 * Default: LOCAL/TEST against TEST_DATABASE_URL.
 * Staging rehearsal: set SUAS_ENV=STAGING and DATABASE_URL to the synthetic
 * Neon unpooled URL (no production markers).
 *
 * Prints structured JSON with opaque identifiers and no contact data.
 */

import { loadConfig } from '../src/config/index.js';
import { createPool } from '../src/db/index.js';
import { runDeletionDrill } from '../src/privacy/deletion-drill.js';
import { testDatabaseUrl, validEnv } from '../tests/helpers/env.js';

async function main(): Promise<void> {
  const environment = process.env.SUAS_ENV === 'STAGING' ? 'STAGING' : 'TEST';
  const databaseUrl =
    process.env.DATABASE_URL !== undefined && process.env.DATABASE_URL !== ''
      ? process.env.DATABASE_URL
      : testDatabaseUrl();

  const config = loadConfig(
    validEnv({
      SUAS_ENV: environment,
      SUAS_MIGRATIONS_MODE: 'validate',
      DATABASE_URL: databaseUrl,
      ...(environment === 'STAGING'
        ? { SUAS_SESSION_SECRET: process.env.SUAS_SESSION_SECRET ?? 'a'.repeat(48) }
        : {}),
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
