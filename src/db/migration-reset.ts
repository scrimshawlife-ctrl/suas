/**
 * Fail-closed rebuild of a synthetic disposable database.
 *
 * D-053 (review F4; owner decision 2026-11-05, recorded in suas-specs PR #66):
 * the rewritten baseline has no in-place upgrade and no down migrations. The
 * only rebuild is an explicit reset, and it runs only when the target database
 * name or URL is on an allowlist and the database name contains a required
 * synthetic marker. Anything else is refused. Checksum refusal stays in
 * migrator.ts and is not bypassed here.
 *
 * An operator-chosen marker does not prove the data is synthetic. Until a
 * trusted registry of synthetic targets exists, reset is LOCAL and TEST only.
 * STAGING and PRODUCTION are refused. The checked-out connection must be the
 * authorized target before any schema statement runs.
 */

import type { Pool, PoolClient } from 'pg';
import { ambientConnectionEnv, type AmbientConnectionEnv } from '../config/ambient-connection.js';
import { productionDataMarkersIn, type EnvironmentClass } from '../config/schema.js';
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

interface AuthorizedEndpoint {
  readonly user: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly url: string;
}

/** Database name from a Postgres URL, or undefined when the URL has none. */
export function databaseNameFromUrl(databaseUrl: string): string | undefined {
  const endpoint = parsePostgresEndpoint(databaseUrl);
  return endpoint?.database;
}

function parsePostgresEndpoint(databaseUrl: string): AuthorizedEndpoint | undefined {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
  let name: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  } catch {
    return undefined;
  }
  if (name === '' || name.includes('/')) return undefined;
  const port = parsed.port === '' ? 5432 : Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  let user: string | undefined;
  if (parsed.username !== '') {
    try {
      user = decodeURIComponent(parsed.username);
    } catch {
      return undefined;
    }
  }
  return {
    user,
    host: parsed.hostname.toLowerCase(),
    port,
    database: name,
    url: databaseUrl.trim(),
  };
}

function namedAllowlist(allowlist: readonly string[]): string[] {
  return [...new Set(allowlist.map((entry) => entry.trim()).filter((entry) => entry !== ''))];
}

/** A bare database name, or a postgres URL that itself names a database. */
function allowlistEntryWellFormed(entry: string): boolean {
  if (entry.includes('://') || entry.includes('/') || /\s/.test(entry)) {
    return parsePostgresEndpoint(entry) !== undefined;
  }
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry);
}

/**
 * Why this target must not be reset, or undefined when the policy itself passes.
 * Pure: no database connection and no schema change.
 */
export function migrationResetRefusal(policy: MigrationResetPolicy): string | undefined {
  if (policy.environment !== 'LOCAL' && policy.environment !== 'TEST') {
    return (
      `Migration reset is refused when SUAS_ENV=${policy.environment}. Only LOCAL and TEST ` +
      'may reset a named synthetic disposable database. There is no in-place upgrade and ' +
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
  if (allowlist.some((entry) => !allowlistEntryWellFormed(entry))) {
    return 'Migration reset refused: an allowlist entry is malformed.';
  }

  const url = policy.databaseUrl?.trim() ?? '';
  if (url === '') {
    return 'Migration reset requires DATABASE_URL. An unnamed target is refused.';
  }

  const endpoint = parsePostgresEndpoint(url);
  if (endpoint === undefined) {
    return 'Migration reset refused: DATABASE_URL is malformed or has no database name.';
  }

  const markers = productionDataMarkersIn(url);
  if (markers.length > 0) {
    return (
      `Migration reset refused: DATABASE_URL host/database name contains production marker(s) ` +
      `${markers.map((marker) => `"${marker}"`).join(', ')}. ` +
      'LOCAL and TEST must not point at production data resources.'
    );
  }

  if (!endpoint.database.includes(marker)) {
    return (
      `Migration reset refused: database "${endpoint.database}" does not contain the synthetic marker ` +
      `"${marker}".`
    );
  }

  if (!allowlist.includes(endpoint.database) && !allowlist.includes(url)) {
    return `Migration reset refused: database "${endpoint.database}" is not on SUAS_MIGRATION_RESET_ALLOWLIST.`;
  }

  return undefined;
}

function ambientValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * libpq-style environment and DATABASE_URL can redirect a connection that does
 * not pin every field. A value that disagrees with the authorized target refuses
 * the reset before any connection is checked out.
 */
function ambientOverrideRefusal(
  authorized: AuthorizedEndpoint,
  ambient: AmbientConnectionEnv,
): string | undefined {
  const databaseUrl = ambientValue(ambient.DATABASE_URL);
  if (databaseUrl !== undefined && databaseUrl !== authorized.url) {
    return 'Migration reset refused: DATABASE_URL does not match the authorized target.';
  }

  const pgHost = ambientValue(ambient.PGHOST);
  if (pgHost !== undefined && pgHost.toLowerCase() !== authorized.host) {
    return 'Migration reset refused: PGHOST does not match the authorized target.';
  }

  const exact: readonly (readonly [string, string | undefined])[] = [
    ['PGPORT', ambientValue(ambient.PGPORT)],
    ['PGDATABASE', ambientValue(ambient.PGDATABASE)],
    ['PGUSER', ambientValue(ambient.PGUSER)],
    ['PGPASSWORD', ambientValue(ambient.PGPASSWORD)],
  ];
  const expected: readonly (string | undefined)[] = [
    String(authorized.port),
    authorized.database,
    authorized.user,
    passwordFromUrl(authorized.url),
  ];
  const names = ['PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const;
  for (let index = 0; index < names.length; index += 1) {
    const actual = exact[index]?.[1];
    const wanted = expected[index];
    if (actual === undefined) continue;
    if (wanted === undefined || actual !== wanted) {
      return `Migration reset refused: ${names[index] ?? 'PG'} does not match the authorized target.`;
    }
  }
  return undefined;
}

function passwordFromUrl(databaseUrl: string): string | undefined {
  try {
    const parsed = new URL(databaseUrl);
    if (parsed.password === '') return undefined;
    return decodeURIComponent(parsed.password);
  } catch {
    return undefined;
  }
}

function connectionMatches(
  client: PoolClient,
  currentDatabase: string | undefined,
  authorized: AuthorizedEndpoint,
): boolean {
  return (
    currentDatabase === authorized.database &&
    client.database === authorized.database &&
    client.host.toLowerCase() === authorized.host &&
    client.port === authorized.port &&
    (authorized.user === undefined || client.user === authorized.user)
  );
}

/**
 * Drop `public` and apply the baseline. Refuses before any schema statement
 * when the policy, the process environment, or the checked-out connection is
 * not the authorized LOCAL/TEST disposable target.
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

  const authorized = parsePostgresEndpoint(policy.databaseUrl?.trim() ?? '');
  if (authorized === undefined) {
    throw new SchemaStateError([
      'Migration reset refused: DATABASE_URL is malformed or has no database name.',
    ]);
  }

  const ambient = ambientOverrideRefusal(authorized, ambientConnectionEnv());
  if (ambient !== undefined) {
    throw new SchemaStateError([ambient]);
  }

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch {
    throw new SchemaStateError([
      'Migration reset refused: the connection could not be checked against the authorized target.',
    ]);
  }

  try {
    const observed = await client.query<{ current_database: string }>(
      'SELECT current_database() AS current_database',
    );
    const currentDatabase = observed.rows[0]?.current_database;
    if (!connectionMatches(client, currentDatabase, authorized)) {
      throw new SchemaStateError([
        'Migration reset refused: the checked-out connection does not match the authorized target.',
      ]);
    }
  } finally {
    client.release();
  }

  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool, { mode: 'apply', provenance });
}
