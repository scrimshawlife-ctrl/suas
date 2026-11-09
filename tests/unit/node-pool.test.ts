/**
 * An idle-client failure must be logged, not thrown: pg-pool emits 'error' on the pool and
 * an unhandled 'error' event would crash the process.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createPool } from '../../src/db/pool.js';
import { validEnv } from '../helpers/env.js';

describe('createPool (node)', () => {
  it('logs an idle client error instead of throwing', async () => {
    const pool = createPool(loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off' })), 'node');
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
