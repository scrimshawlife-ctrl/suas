import { describe, expect, it } from 'vitest';
import { createWorkerPool } from '../../src/db/pool.js';
import type { SuasConfig } from '../../src/config/index.js';

describe('createWorkerPool', () => {
  it('exposes query/connect/end without retaining a pg.Pool', () => {
    const config = {
      database: {
        url: 'postgresql://example.invalid:5432/suas',
        poolMax: 1,
        migrationsMode: 'validate',
      },
    } as SuasConfig;
    const pool = createWorkerPool(config);
    expect(typeof pool.query).toBe('function');
    expect(typeof pool.connect).toBe('function');
    expect(typeof pool.end).toBe('function');
  });
});
