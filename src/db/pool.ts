/**
 * PostgreSQL connection pool.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §3 invariant 2 (one logical PostgreSQL system of record)
 * - SUAS-specs ENVIRONMENT.md §3 "Data / persistence" (bounded DATABASE_POOL_MAX)
 * - SUAS-specs ARCHITECTURE.md §13 (finite timeouts)
 */

import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { Pool } from 'pg';
import type { SuasConfig } from '../config/index.js';

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super(
      'DATABASE_URL is not configured; persistence is unavailable in this process ' +
        '(SUAS-specs ENVIRONMENT.md §3 "Data / persistence").',
    );
    this.name = 'DatabaseNotConfiguredError';
  }
}

export { DEFAULT_QUERY_TIMEOUT_MS } from '../config/index.js';

/** pg's message when `query_timeout` fires; the connection may still be busy server-side. */
export const QUERY_TIMEOUT_MESSAGE = 'Query read timeout';

export interface PoolOptions {
  /** Overrides `config.database.queryTimeoutMillis` (`DATABASE_QUERY_TIMEOUT_MS`). */
  readonly queryTimeoutMillis?: number;
}

/** Connection string and TLS settings for the pool. */
export function databaseClientSettings(config: SuasConfig): {
  connectionString: string;
  ssl?: ConnectionOptions;
} {
  const url = config.database.url;
  if (url === undefined) throw new DatabaseNotConfiguredError();
  const ssl = databaseSslOptions(config.database.ssl);
  return {
    connectionString: url,
    ...(ssl !== undefined ? { ssl } : {}),
  };
}

/**
 * TLS settings for the pool (config `DATABASE_SSL_MODE`).
 * `verify` checks the certificate chain and host name; a CA bundle file, such as
 * the AWS RDS global bundle, replaces the default trust store. Returns undefined
 * for `disable`, leaving the connection string to decide as before.
 */
export function databaseSslOptions(
  ssl: SuasConfig['database']['ssl'],
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): ConnectionOptions | undefined {
  if (ssl.mode === 'disable') return undefined;
  return {
    rejectUnauthorized: true,
    ...(ssl.caFile !== undefined ? { ca: readFile(ssl.caFile) } : {}),
  };
}

export function createPool(config: SuasConfig, options: PoolOptions = {}): Pool {
  const settings = databaseClientSettings(config);
  const pool = new Pool({
    ...settings,
    max: config.database.poolMax,
    // Finite timeouts, per ARCHITECTURE.md §13. These are implementation
    // mechanism values; no production SLO is implied (RELEASE_MANIFEST-0.1.1.md).
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: options.queryTimeoutMillis ?? config.database.queryTimeoutMillis,
  });
  // An idle client can fail (database restart, dropped connection). pg-pool has already
  // removed it, and an unhandled 'error' event would crash the process, so log and carry on.
  // Only the error name and code (SQLSTATE or errno) are logged: driver messages can name the
  // database host, port, or role, which stay out of logs.
  pool.on('error', (error) => {
    const code = (error as { code?: unknown }).code;
    console.error(
      JSON.stringify({
        level: 'error',
        msg: 'db_pool_idle_client_error',
        error_name: error.name,
        error_code: typeof code === 'string' ? code.slice(0, 32) : 'unknown',
      }),
    );
  });
  return pool;
}
