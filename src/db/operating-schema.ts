/**
 * Request-path schema check that never applies migrations.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §9 (a build rejects a schema state it cannot
 *   safely operate against; schema compatibility is not inferred from the
 *   application version)
 * - SUAS-specs ENVIRONMENT.md §3 (production automatic-migration policy must
 *   be explicit in deployment runbooks; the request path is not that runbook)
 *
 * The Node migrate CLI still owns `apply` and the full file/checksum plan.
 * Cloudflare Workers have no on-disk `migrations/` tree, so the Worker isolate
 * only reads the recorded schema version and fails closed if it is not the
 * version this build requires.
 */

import type { Pool } from 'pg';
import { readSchemaVersion, SchemaStateError } from './migrator.js';
import { EXPECTED_SCHEMA_VERSION } from './schema-version.js';

/**
 * Confirm the database is already at this build's required schema version.
 * Performs SELECT only. Never runs DDL, never records a migration, never
 * creates the bookkeeping table.
 */
export async function assertExpectedSchemaVersion(
  db: Pick<Pool, 'query'>,
  expected: number = EXPECTED_SCHEMA_VERSION,
): Promise<number> {
  let version: number;
  try {
    version = await readSchemaVersion(db);
  } catch {
    throw new SchemaStateError([
      `Could not read schema version; this build requires ${expected}. ` +
        `The Worker request path never applies migrations. Run ` +
        `\`npm run migrate -- apply\` against the unpooled URL, then ` +
        `\`npm run migrate -- validate\`.`,
    ]);
  }

  if (version !== expected) {
    throw new SchemaStateError([
      `Database schema version is ${version} but this build requires ${expected}. ` +
        `Schema compatibility is not inferred from the application version ` +
        `(ENVIRONMENT.md §9). The Worker request path never applies migrations.`,
    ]);
  }

  return version;
}
