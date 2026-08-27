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
 * Per-request Client factory that satisfies the `Pool` surface used by SUAS
 * (`query`, `connect`/`release`, `end`). No connections are retained between
 * calls — required on Workers with Hyperdrive.
 */
export function createWorkerPool(config: SuasConfig): Pool {
  const url = config.database.url;
  if (url === undefined) {
    throw new DatabaseNotConfiguredError();
  }

  const openClient = async (): Promise<Client> => {
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: 10_000,
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

export function createPool(config: SuasConfig, mode: PoolMode = 'node'): Pool {
  if (mode === 'worker') {
    return createWorkerPool(config);
  }

  const url = config.database.url;
  if (url === undefined) {
    throw new DatabaseNotConfiguredError();
  }
  return new Pool({
    connectionString: url,
    max: config.database.poolMax,
    // Finite timeouts, per ARCHITECTURE.md §13. These are implementation
    // mechanism values; no production SLO is implied (RELEASE_MANIFEST-0.1.1.md).
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
  });
}
