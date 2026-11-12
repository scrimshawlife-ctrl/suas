/**
 * An idle-client failure must be logged, not thrown: pg-pool emits 'error' on the pool and
 * an unhandled 'error' event would crash the process. Queries carry a finite timeout
 * (ARCHITECTURE.md §13), and a timed-out transaction client is discarded, not reused.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import type { Pool } from 'pg';
import { createPool, DEFAULT_QUERY_TIMEOUT_MS, QUERY_TIMEOUT_MESSAGE } from '../../src/db/pool.js';
import { withTransaction } from '../../src/db/transaction.js';
import { validEnv } from '../helpers/env.js';

describe('createPool (node)', () => {
  it('logs an idle client error instead of throwing', async () => {
    const pool = createPool(loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off' })));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const error = Object.assign(
        new Error('connect ECONNREFUSED db.internal.example:5432 for role suas_app'),
        { code: 'ECONNREFUSED' },
      );
      expect(() => pool.emit('error', error)).not.toThrow();
      expect(log).toHaveBeenCalledOnce();
      const line = String(log.mock.calls[0]?.[0]);
      expect(line).toContain('db_pool_idle_client_error');
      expect(JSON.parse(line).error_code).toBe('ECONNREFUSED');
      // The driver message can name the host, port or role; none of it is logged.
      expect(line).not.toMatch(/db\.internal|5432|suas_app/);
    } finally {
      log.mockRestore();
      await pool.end();
    }
  });
});

describe('query timeouts (A4-06)', () => {
  it('bounds every query by default and takes an override', async () => {
    const config = loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off' }));
    const bounded = createPool(config);
    const custom = createPool(config, { queryTimeoutMillis: 5_000 });
    try {
      expect(bounded.options.query_timeout).toBe(DEFAULT_QUERY_TIMEOUT_MS);
      expect(custom.options.query_timeout).toBe(5_000);
    } finally {
      await bounded.end();
      await custom.end();
    }
  });

  it('reads DATABASE_QUERY_TIMEOUT_MS and refuses a value that is not a positive integer', async () => {
    const pool = createPool(
      loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off', DATABASE_QUERY_TIMEOUT_MS: '7000' })),
    );
    try {
      expect(pool.options.query_timeout).toBe(7_000);
    } finally {
      await pool.end();
    }
    for (const bad of ['0', '-1', '2.5', 'soon']) {
      expect(() =>
        loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off', DATABASE_QUERY_TIMEOUT_MS: bad })),
      ).toThrow(/DATABASE_QUERY_TIMEOUT_MS/);
    }
  });

  it('discards a transaction client whose query timed out instead of reusing it', async () => {
    const sent: string[] = [];
    const release = vi.fn();
    const client = {
      query: (text: string) => {
        sent.push(text);
        return text === 'BEGIN'
          ? Promise.resolve({ rows: [] })
          : Promise.reject(new Error(QUERY_TIMEOUT_MESSAGE));
      },
      release,
    };
    const pool = { connect: () => Promise.resolve(client) } as unknown as Pool;

    await expect(withTransaction(pool, (tx) => tx.query('SELECT pg_sleep(60)'))).rejects.toThrow(
      QUERY_TIMEOUT_MESSAGE,
    );
    expect(sent).toEqual(['BEGIN', 'SELECT pg_sleep(60)']);
    expect(release).toHaveBeenCalledWith(true);
  });
});
