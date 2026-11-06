/**
 * Process environment the pinned `pg` client can apply to a connection.
 *
 * These are not released configuration variables. The reset reads them here
 * and refuses when they disagree with the authorized target, or when they
 * would add a session or routing parameter the reset URL is not allowed to
 * carry. `process.env` stays in this module.
 *
 * Pure-JS client (`node_modules/pg` 8.23, `lib/connection-parameters.js`):
 * `val()` reads `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`,
 * `PGOPTIONS`, `PGCLIENT_ENCODING`, `PGREPLICATION`, and `PGBINARY`.
 * `PGSSLMODE` and `PGSSLNEGOTIATION` are read beside that. `PGAPPNAME` is
 * read as `application_name` and does not select a server. `PGCONNECT_TIMEOUT`
 * only bounds the connect wait. `pgpass` reads `PGPASSFILE` when the password
 * is absent (`lib/client.js`).
 *
 * `PGHOSTADDR`, `PGSERVICE`, `PGSERVICEFILE`, and `PGTARGETSESSIONATTRS` are
 * not read by that pure-JS client. `NODE_PG_FORCE_NATIVE` loads `pg-native`,
 * and libpq does read them, along with the `PGSSL*` certificate and
 * compression variables. A set value refuses the reset.
 */

export const AMBIENT_SESSION_ENV_KEYS = [
  'PGOPTIONS',
  'PGSSLMODE',
  'PGSSLNEGOTIATION',
  'PGSSLCERT',
  'PGSSLKEY',
  'PGSSLROOTCERT',
  'PGSSLCRL',
  'PGSSLCOMPRESSION',
  'PGCLIENT_ENCODING',
  'PGREPLICATION',
  'PGBINARY',
  'PGPASSFILE',
  'PGHOSTADDR',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGTARGETSESSIONATTRS',
  'NODE_PG_FORCE_NATIVE',
] as const;

export type AmbientSessionEnvKey = (typeof AMBIENT_SESSION_ENV_KEYS)[number];

export interface AmbientConnectionEnv {
  readonly DATABASE_URL: string | undefined;
  readonly PGHOST: string | undefined;
  readonly PGPORT: string | undefined;
  readonly PGUSER: string | undefined;
  readonly PGPASSWORD: string | undefined;
  readonly PGDATABASE: string | undefined;
  readonly session: Readonly<Record<AmbientSessionEnvKey, string | undefined>>;
}

export function ambientConnectionEnv(): AmbientConnectionEnv {
  const session = {} as Record<AmbientSessionEnvKey, string | undefined>;
  for (const key of AMBIENT_SESSION_ENV_KEYS) {
    session[key] = process.env[key];
  }
  return {
    DATABASE_URL: process.env.DATABASE_URL,
    PGHOST: process.env.PGHOST,
    PGPORT: process.env.PGPORT,
    PGUSER: process.env.PGUSER,
    PGPASSWORD: process.env.PGPASSWORD,
    PGDATABASE: process.env.PGDATABASE,
    session,
  };
}
