/**
 * Postgres outbox durable job queue (D-022).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertJobPortConformance,
  claimDueJobs,
  markJobFailed,
  markJobSucceeded,
  PostgresOutboxJobQueue,
} from '../../src/jobs/index.js';
import { createTestPool } from '../helpers/db.js';

describe('PostgresOutboxJobQueue', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('satisfies port conformance as a durable implementation', async () => {
    const queue = new PostgresOutboxJobQueue(pool);
    const result = await assertJobPortConformance(queue);
    expect(result.durability).toBe('durable');
    expect(result.implementation).toBe('postgres-outbox');
  });

  it('claims due jobs with SKIP LOCKED and completes successfully', async () => {
    const queue = new PostgresOutboxJobQueue(pool);
    const tenantId = randomUUID();
    const enqueued = await queue.enqueue({
      jobType: 'test.claim',
      payload: { n: 1 },
      tenantId,
      idempotencyKey: `claim-${randomUUID()}`,
    });

    const claimed = await claimDueJobs(pool, { owner: 'worker-a', limit: 50 });
    const mine = claimed.find((job) => job.jobId === enqueued.jobId);
    expect(mine).toBeDefined();
    expect(mine?.status).toBe('LEASED');
    expect(mine?.attempts).toBe(1);

    await markJobSucceeded(pool, enqueued.jobId);
    const again = await claimDueJobs(pool, { owner: 'worker-b', limit: 50 });
    expect(again.some((job) => job.jobId === enqueued.jobId)).toBe(false);
  });

  it('dead-letters after max attempts', async () => {
    const queue = new PostgresOutboxJobQueue(pool);
    const enqueued = await queue.enqueue({
      jobType: 'test.fail',
      payload: {},
      tenantId: randomUUID(),
      maxAttempts: 1,
      idempotencyKey: `fail-${randomUUID()}`,
    });

    const claimed = await claimDueJobs(pool, { owner: 'worker-fail', limit: 50 });
    expect(claimed.some((job) => job.jobId === enqueued.jobId)).toBe(true);

    const status = await markJobFailed(pool, {
      jobId: enqueued.jobId,
      error: 'synthetic failure',
    });
    expect(status).toBe('DEAD_LETTER');
  });
});
