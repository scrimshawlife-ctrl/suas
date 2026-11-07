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

import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import {
  AMBIENT_SESSION_ENV_KEYS,
  ambientConnectionEnv,
  type AmbientConnectionEnv,
} from '../config/ambient-connection.js';
import { productionDataMarkersIn, type EnvironmentClass } from '../config/schema.js';
import { trustedEnvironmentClass } from '../config/trusted-environment.js';
import { runMigrationsOnClient, SchemaStateError, type SchemaProvenance } from './migrator.js';

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
  readonly user: string;
  readonly password: string;
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

/**
 * Reset URLs must name every connection field. A missing user, password, host,
 * or port would fall back to ambient PG* defaults. Fragments and query
 * parameters (routing, duplicate, or unknown) are rejected. The same rules
 * apply to a full URL on the allowlist.
 */
function parsePostgresEndpoint(databaseUrl: string): AuthorizedEndpoint | undefined {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') return undefined;
  if (parsed.hash !== '') return undefined;
  if (parsed.search !== '') return undefined;
  if (parsed.username === '' || parsed.password === '') return undefined;
  if (parsed.hostname === '' || parsed.port === '') return undefined;
  let name: string;
  let user: string;
  let password: string;
  try {
    name = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    user = decodeURIComponent(parsed.username);
    password = decodeURIComponent(parsed.password);
  } catch {
    return undefined;
  }
  if (name === '' || name.includes('/') || user === '' || password === '') return undefined;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return {
    user,
    host: parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
    port,
    database: name,
    url: databaseUrl.trim(),
    password,
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
 * No database connection and no schema change. The environment class is the
 * process `SUAS_ENV` from the config module, not the caller-supplied policy field.
 */
export function migrationResetRefusal(policy: MigrationResetPolicy): string | undefined {
  // The process environment is the trusted class. A caller cannot pass TEST while
  // SUAS_ENV is STAGING and reach the DROP. D-053 allows the reset only for LOCAL
  // and TEST, and only for the rest of the allowlist checks below.
  const trusted = trustedEnvironmentClass();
  if (trusted !== 'LOCAL' && trusted !== 'TEST') {
    return (
      `Migration reset is refused when SUAS_ENV=${trusted ?? 'unset'}. Only LOCAL and TEST ` +
      'may reset a named synthetic disposable database. A caller-supplied environment does not override SUAS_ENV. ' +
      'There is no in-place upgrade and no down migration.'
    );
  }
  if (policy.environment !== trusted) {
    return `Migration reset is refused: claimed environment ${policy.environment} does not match SUAS_ENV=${trusted}.`;
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
 * the reset before any connection is checked out. Session and routing variables
 * the pinned driver can apply, and that the reset URL is not allowed to name,
 * refuse the reset when they are set at all.
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
    authorized.password,
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

  for (const key of AMBIENT_SESSION_ENV_KEYS) {
    if (ambientValue(ambient.session[key]) !== undefined) {
      return `Migration reset refused: ${key} is set.`;
    }
  }
  return undefined;
}

interface LiveServer {
  readonly database: string | undefined;
  readonly address: string | null;
  readonly port: number | null;
}

/**
 * A hostname is ambiguous (localhost is both 127.0.0.1 and ::1) and a null
 * server address is an unsupported topology (a local socket, for example).
 * Only an explicit IP literal can be compared to inet_server_addr().
 */
function liveServerRefusal(live: LiveServer, authorized: AuthorizedEndpoint): string | undefined {
  if (live.address === null || live.port === null || isIP(authorized.host) === 0) {
    return 'Migration reset refused: the server topology is unsupported or ambiguous.';
  }
  const liveAddress = live.address.trim().toLowerCase();
  if (isIP(liveAddress) === 0) {
    return 'Migration reset refused: the server topology is unsupported or ambiguous.';
  }
  if (
    liveAddress !== authorized.host ||
    live.port !== authorized.port ||
    live.database !== authorized.database
  ) {
    return 'Migration reset refused: the checked-out connection does not match the authorized target.';
  }
  return undefined;
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

  let client: PoolClient | undefined;
  try {
    try {
      client = await pool.connect();
    } catch {
      throw new SchemaStateError([
        'Migration reset refused: the connection could not be checked against the authorized target.',
      ]);
    }

    const observed = await client.query<{
      current_database: string;
      server_addr: string | null;
      server_port: number | null;
    }>(
      `SELECT current_database() AS current_database,
              host(inet_server_addr()) AS server_addr,
              inet_server_port() AS server_port`,
    );
    const row = observed.rows[0];
    const topology = liveServerRefusal(
      {
        database: row?.current_database,
        address: row?.server_addr ?? null,
        port: row?.server_port ?? null,
      },
      authorized,
    );
    if (topology !== undefined) {
      throw new SchemaStateError([topology]);
    }

    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await runMigrationsOnClient(client, { mode: 'apply', provenance });
  } finally {
    client?.release();
  }
}
