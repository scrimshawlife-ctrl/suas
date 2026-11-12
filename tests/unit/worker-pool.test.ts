import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

const pg = vi.hoisted(() => {
  const constructed: unknown[] = [];
  const connect = vi.fn(() => Promise.resolve());
  const query = vi.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
  const end = vi.fn(() => Promise.resolve());
  return { constructed, connect, query, end };
});

vi.mock('pg', () => {
  class Client {
    constructor(options: unknown) {
      pg.constructed.push(options);
    }
    connect = pg.connect;
    query = pg.query;
    end = pg.end;
  }
  class Pool {
    constructor(_options: unknown) {
      // The Worker pool does not construct pg.Pool.
    }
  }
  return { Client, Pool };
});

const { createWorkerPool, DatabaseNotConfiguredError, DEFAULT_QUERY_TIMEOUT_MS } =
  await import('../../src/db/pool.js');

beforeEach(() => {
  pg.constructed.length = 0;
  pg.connect.mockClear();
  pg.query.mockClear();
  pg.end.mockClear();
});

describe('createWorkerPool', () => {
  it('fails at construction when DATABASE_URL is absent', () => {
    const config = loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off', DATABASE_URL: undefined }));
    expect(config.database.url).toBeUndefined();
    expect(() => createWorkerPool(config)).toThrow(DatabaseNotConfiguredError);
    expect(pg.constructed).toEqual([]);
  });

  it('constructs each Worker client with the verify TLS settings', async () => {
    const config = loadConfig(
      validEnv({
        DATABASE_SSL_MODE: 'verify',
        DATABASE_URL: 'postgresql://suas:suas@db.example.invalid:5432/suas',
      }),
    );
    const pool = createWorkerPool(config);
    await pool.query('select 1');
    expect(pg.constructed).toEqual([
      {
        connectionString: 'postgresql://suas:suas@db.example.invalid:5432/suas',
        ssl: { rejectUnauthorized: true },
        connectionTimeoutMillis: 10_000,
        query_timeout: DEFAULT_QUERY_TIMEOUT_MS,
      },
    ]);
    expect(pg.connect).toHaveBeenCalledOnce();
  });

  it('constructs a plain Worker client when TLS is disabled', async () => {
    const config = loadConfig(validEnv());
    const pool = createWorkerPool(config);
    await pool.query('select 1');
    expect(pg.constructed).toEqual([
      {
        connectionString: config.database.url,
        connectionTimeoutMillis: 10_000,
        query_timeout: DEFAULT_QUERY_TIMEOUT_MS,
      },
    ]);
  });
});
