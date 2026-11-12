/**
 * PostgreSQL connection pool.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §3 invariant 2 (one logical PostgreSQL system of record)
 * - SUAS-specs ENVIRONMENT.md §3 "Data / persistence" (bounded DATABASE_POOL_MAX)
 * - SUAS-specs ARCHITECTURE.md §13 (finite timeouts)
 *
 * Cloudflare Workers + Hyperdrive: do not reuse a `pg.Pool` across requests.
 * Hyperdrive is the network pooler; each request must open its own `Client`
 * (Workers I/O cannot cross request boundaries). See Cloudflare Hyperdrive
 * node-postgres guidance.
 */

import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';
import { Client, Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
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

export type PoolMode = 'node' | 'worker';

/**
 * Client-side bound on one query (ARCHITECTURE.md §13 finite timeouts). Below the 29 s
 * API Gateway and 30 s Lambda limits so the caller still answers. Client-side, so RDS
 * Proxy sees no session setting. A mechanism value, not an SLO.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 20_000;

/** pg's message when `query_timeout` fires; the connection may still be busy server-side. */
export const QUERY_TIMEOUT_MESSAGE = 'Query read timeout';

export interface PoolOptions {
  /** Overrides {@link DEFAULT_QUERY_TIMEOUT_MS}. */
  readonly queryTimeoutMillis?: number;
}

/** Connection settings shared by the Node pool and the per-request Worker client. */
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
 * Per-request Client factory that satisfies the `Pool` surface used by SUAS
 * (`query`, `connect`/`release`, `end`). No connections are retained between
 * calls — required on Workers with Hyperdrive. TLS matches the Node pool.
 */
export function createWorkerPool(config: SuasConfig, options: PoolOptions = {}): Pool {
  // Missing DATABASE_URL fails here, before a request opens a client. The same
  // settings, including TLS, are what each per-request Client is constructed with.
  const settings = databaseClientSettings(config);

  const openClient = async (): Promise<Client> => {
    const client = new Client({
      ...settings,
      connectionTimeoutMillis: 10_000,
      query_timeout: options.queryTimeoutMillis ?? DEFAULT_QUERY_TIMEOUT_MS,
    });
    await client.connect();
    return client;
  };

  const workerPool = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: unknown[],
    ): Promise<QueryResult<R>> {
      const client = await openClient();
      try {
        return await client.query<R>(text, values);
      } finally {
        await client.end().catch(() => {
          // Prefer the query error if both fail.
        });
      }
    },

    async connect(): Promise<PoolClient> {
      const client = await openClient();
      const poolClient = client as PoolClient;
      poolClient.release = () => {
        void client.end().catch(() => {
          // Release must not throw into withTransaction's finally.
        });
      };
      return poolClient;
    },

    async end(): Promise<void> {
      // No retained connections.
    },
  };

  return workerPool as unknown as Pool;
}

/**
 * TLS settings for both pools (config `DATABASE_SSL_MODE`).
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

export function createPool(
  config: SuasConfig,
  mode: PoolMode = 'node',
  options: PoolOptions = {},
): Pool {
  if (mode === 'worker') {
    return createWorkerPool(config, options);
  }

  const settings = databaseClientSettings(config);
  const pool = new Pool({
    ...settings,
    max: config.database.poolMax,
    // Finite timeouts, per ARCHITECTURE.md §13. These are implementation
    // mechanism values; no production SLO is implied (RELEASE_MANIFEST-0.1.1.md).
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    query_timeout: options.queryTimeoutMillis ?? DEFAULT_QUERY_TIMEOUT_MS,
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
