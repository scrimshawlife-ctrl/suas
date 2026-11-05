/**
 * Fail-closed rebuild of a synthetic disposable database.
 *
 * D-053 (review F4; owner decision 2026-11-05, recorded in suas-specs PR #66):
 * the rewritten baseline has no in-place upgrade and no down migrations. The
 * only rebuild is an explicit reset, and it runs only when the target database
 * name or URL is on an allowlist and the database name contains a required
 * synthetic marker. Anything else is refused. Checksum refusal stays in
 * migrator.ts and is not bypassed here.
 */

import type { Pool } from 'pg';
import type { EnvironmentClass } from '../config/schema.js';
import { runMigrations, SchemaStateError, type SchemaProvenance } from './migrator.js';

export interface MigrationResetPolicy {
  readonly environment: EnvironmentClass;
  /** Connection URL of the database this process would reset. */
  readonly databaseUrl: string | undefined;
  /** Database names or full URLs the operator named as disposable. */
  readonly allowlist: readonly string[];
  /** Substring that must appear in the database name. Empty refuses. */
  readonly syntheticMarker: string | undefined;
}

/** Database name from a Postgres URL, or undefined when the URL has none. */
export function databaseNameFromUrl(databaseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return undefined;
  }
  if (name === '' || name.includes('/')) return undefined;
  return name;
}

function namedAllowlist(allowlist: readonly string[]): string[] {
  return [...new Set(allowlist.map((entry) => entry.trim()).filter((entry) => entry !== ''))];
}

/**
 * Why this target must not be reset, or undefined when both gates pass.
 * Pure: no database connection and no schema change.
 */
export function migrationResetRefusal(policy: MigrationResetPolicy): string | undefined {
  if (policy.environment === 'PRODUCTION') {
    return (
      'Migration reset is refused when SUAS_ENV=PRODUCTION. There is no in-place upgrade and ' +
      'no down migration.'
    );
  }

  const marker = policy.syntheticMarker?.trim() ?? '';
  if (marker === '') {
    return (
      'Migration reset requires SUAS_MIGRATION_RESET_SYNTHETIC_MARKER. A database without ' +
      'that marker is refused.'
    );
  }

  const allowlist = namedAllowlist(policy.allowlist);
  if (allowlist.length === 0) {
    return (
      'Migration reset requires SUAS_MIGRATION_RESET_ALLOWLIST to name the disposable ' +
      'database. An unnamed target is refused.'
    );
  }

  const url = policy.databaseUrl?.trim() ?? '';
  if (url === '') {
    return 'Migration reset requires DATABASE_URL. An unnamed target is refused.';
  }

  const name = databaseNameFromUrl(url);
  if (name === undefined) {
    return 'Migration reset refused: DATABASE_URL has no database name.';
  }

  if (!name.includes(marker)) {
    return (
      `Migration reset refused: database "${name}" does not contain the synthetic marker ` +
      `"${marker}".`
    );
  }

  if (!allowlist.includes(name) && !allowlist.includes(url)) {
    return `Migration reset refused: database "${name}" is not on SUAS_MIGRATION_RESET_ALLOWLIST.`;
  }

  return undefined;
}

/**
 * Drop `public` and apply the baseline. Refuses before any statement when the
 * policy does not name this database as a synthetic disposable target.
 */
export async function resetSyntheticDatabase(
  pool: Pool,
  policy: MigrationResetPolicy,
  provenance: SchemaProvenance,
): Promise<void> {
  const refusal = migrationResetRefusal(policy);
  if (refusal !== undefined) {
    throw new SchemaStateError([refusal]);
  }

  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool, { mode: 'apply', provenance });
}
