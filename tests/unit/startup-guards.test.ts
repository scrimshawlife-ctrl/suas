/**
 * Fail-closed startup guards: the job worker refuses a schema it cannot operate against
 * before any work (A4-05, ENVIRONMENT.md §9), and an unknown SUAS_JOB_QUEUE is a
 * configuration error rather than a silent in-memory fake (A4-15, ENVIRONMENT.md §5).
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { startApp } from '../../src/app.js';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';
import { EXPECTED_SCHEMA_VERSION, SchemaStateError } from '../../src/db/index.js';
import { runJobWorker } from '../../src/jobs/worker.js';
import { validEnv } from '../helpers/env.js';

describe('runJobWorker', () => {
  it('refuses a wrong schema version and runs no sweep or claim', async () => {
    const query = vi.fn(() =>
      Promise.resolve({
        rows: [
          {
            version: EXPECTED_SCHEMA_VERSION - 1,
            name: 'old',
            checksum: 'x',
            applied_at: new Date(),
          },
        ],
      }),
    );
    const pool = { query } as unknown as Pool;

    await expect(
      runJobWorker({
        pool,
        config: loadConfig(validEnv({ SUAS_MIGRATIONS_MODE: 'off' })),
        owner: 'test',
        once: true,
        limit: 1,
      }),
    ).rejects.toThrow(SchemaStateError);
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('SUAS_JOB_QUEUE', () => {
  it('rejects an unknown value at startup', async () => {
    await expect(
      startApp({
        env: validEnv({ SUAS_MIGRATIONS_MODE: 'off', SUAS_JOB_QUEUE: 'postgres' }),
        listen: false,
      }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('names the variable and its allowed values in the config error', () => {
    expect(() => loadConfig(validEnv({ SUAS_JOB_QUEUE: 'postgres' }))).toThrow(
      /SUAS_JOB_QUEUE.*in-memory-fake \| postgres-outbox/,
    );
  });

  it('keeps the in-memory fake when unset', async () => {
    const app = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'off' }), listen: false });
    try {
      expect(app.jobQueue.implementation).toBe('in-memory-fake');
    } finally {
      await app.close();
    }
  });
});
