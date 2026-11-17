/**
 * Postgres outbox durable job queue (D-022).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertJobPortConformance,
  DispatchingJobQueue,
  claimDueJobs,
  markJobFailed,
  markJobSucceeded,
  PostgresOutboxJobQueue,
  holdJobLease,
  renewJobLease,
  runJobUnderLease,
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

    await markJobSucceeded(pool, mine!);
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
    const mine = claimed.find((job) => job.jobId === enqueued.jobId);
    expect(mine).toBeDefined();

    const status = await markJobFailed(pool, {
      lease: mine!,
      error: 'synthetic failure',
    });
    expect(status).toBe('DEAD_LETTER');
  });

  it('marks a job done after inline dispatch so the worker does not run it again', async () => {
    const outbox = new PostgresOutboxJobQueue(pool);
    const queue = new DispatchingJobQueue(
      outbox,
      {
        'test.inline-ok': () => Promise.resolve(),
        'test.inline-bad': () => Promise.reject(new Error('refused')),
      },
      () => undefined,
      (job, run) => runJobUnderLease(pool, { jobId: job.jobId, owner: 'api-inline' }, run),
    );
    const tenantId = randomUUID();
    const done = await queue.enqueue({ jobType: 'test.inline-ok', payload: {}, tenantId });
    const failed = await queue.enqueue({ jobType: 'test.inline-bad', payload: {}, tenantId });

    const claimed = await claimDueJobs(pool, { owner: 'worker-inline', limit: 200 });
    expect(claimed.some((job) => job.jobId === done.jobId)).toBe(false);
    // A failed inline run leaves the row for the worker to retry.
    expect(claimed.some((job) => job.jobId === failed.jobId)).toBe(true);
  });

  describe('lease ownership', () => {
    async function leaseState(jobId: string) {
      const result = await pool.query<{ status: string; lease_owner: string | null }>(
        `SELECT status, lease_owner FROM job_outbox WHERE job_id = $1`,
        [jobId],
      );
      return result.rows[0];
    }

    /** Worker A's lease runs out mid-job and worker B reclaims the row. */
    async function reclaimedJob() {
      const jobType = `test.lease-${randomUUID()}`;
      const enqueued = await new PostgresOutboxJobQueue(pool).enqueue({
        jobType,
        payload: {},
        tenantId: randomUUID(),
      });
      const [a] = await claimDueJobs(pool, { owner: 'worker-a', jobType, leaseMs: 1_000 });
      const later = new Date(Date.now() + 5_000);
      const [b] = await claimDueJobs(pool, { owner: 'worker-b', jobType, now: later });
      return { jobId: enqueued.jobId, a: a!, b: b! };
    }

    it('does not let the stale owner settle a job another worker reclaimed', async () => {
      const { jobId, a } = await reclaimedJob();

      expect(await markJobSucceeded(pool, a)).toBe(false);
      expect(await leaseState(jobId)).toEqual({ status: 'LEASED', lease_owner: 'worker-b' });

      expect(await markJobFailed(pool, { lease: a, error: 'stale owner timed out' })).toBe(
        'LEASE_LOST',
      );
      expect(await leaseState(jobId)).toEqual({ status: 'LEASED', lease_owner: 'worker-b' });
    });

    it('refuses to renew a lease another worker reclaimed, so the stale owner skips the job', async () => {
      const { a, b } = await reclaimedJob();
      expect(await renewJobLease(pool, a)).toBe(false);
      expect(await renewJobLease(pool, b)).toBe(true);
    });

    it('keeps the lease of a job that runs past it, so a second worker cannot reclaim it', async () => {
      const jobType = `test.heartbeat-${randomUUID()}`;
      await new PostgresOutboxJobQueue(pool).enqueue({
        jobType,
        payload: {},
        tenantId: randomUUID(),
      });
      const [a] = await claimDueJobs(pool, { owner: 'worker-a', jobType, leaseMs: 300 });

      let reclaimed: readonly unknown[] = [];
      await holdJobLease(
        pool,
        a!,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 900));
          reclaimed = await claimDueJobs(pool, { owner: 'worker-b', jobType });
        },
        { leaseMs: 300 },
      );

      expect(reclaimed).toHaveLength(0);
      expect(await markJobSucceeded(pool, a!)).toBe(true);
    });
  });
});
