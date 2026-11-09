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
      expect(() => pool.emit('error', new Error('connection terminated'))).not.toThrow();
      expect(log).toHaveBeenCalledOnce();
      expect(String(log.mock.calls[0]?.[0])).toContain('db_pool_idle_client_error');
    } finally {
      log.mockRestore();
      await pool.end();
    }
  });
});
