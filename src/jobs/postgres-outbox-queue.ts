/**
 * Durable Postgres outbox job queue (D-022).
 *
 * Spec citations:
 * - ARCHITECTURE.md §3 invariant 5, §8, §10, §13, §16
 * - Decision packet D-022 (Postgres outbox / SKIP LOCKED)
 *
 * Enqueue writes a row that survives process restart. Workers claim due rows
 * with `FOR UPDATE SKIP LOCKED` via {@link claimDueJobs}.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Queryable } from '../db/index.js';
import type {
  DurableJobQueuePort,
  EnqueuedJob,
  JobEnqueueRequest,
  JobQueueDurability,
  JsonObject,
} from './port.js';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_LEASE_MS = 60_000;

export interface JobOutboxRow {
  readonly jobId: string;
  readonly tenantId: string | undefined;
  readonly jobType: string;
  readonly payload: JsonObject;
  readonly idempotencyKey: string | undefined;
  readonly status: 'PENDING' | 'LEASED' | 'SUCCEEDED' | 'DEAD_LETTER';
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly runAt: Date;
}

export class PostgresOutboxJobQueue implements DurableJobQueuePort {
  readonly durability: JobQueueDurability = 'durable';
  readonly implementation = 'postgres-outbox';

  constructor(private readonly db: Queryable) {}

  async enqueue(request: JobEnqueueRequest): Promise<EnqueuedJob> {
    const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const runAt = request.runAt ?? new Date();
    const jobId = randomUUID();

    if (request.idempotencyKey !== undefined) {
      const existing = await this.db.query<{ job_id: string }>(
        `SELECT job_id FROM job_outbox
         WHERE tenant_id IS NOT DISTINCT FROM $1
           AND job_type = $2
           AND idempotency_key = $3
         LIMIT 1`,
        [request.tenantId ?? null, request.jobType, request.idempotencyKey],
      );
      const found = existing.rows[0];
      if (found !== undefined) {
        return { jobId: found.job_id, jobType: request.jobType, deduplicated: true };
      }
    }

    try {
      await this.db.query(
        `INSERT INTO job_outbox (
           job_id, tenant_id, job_type, payload, idempotency_key,
           max_attempts, run_at
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          jobId,
          request.tenantId ?? null,
          request.jobType,
          JSON.stringify(request.payload),
          request.idempotencyKey ?? null,
          maxAttempts,
          runAt.toISOString(),
        ],
      );
    } catch (error: unknown) {
      // Concurrent insert of the same idempotency key — return the winner.
      if (request.idempotencyKey !== undefined && isUniqueViolation(error)) {
        const existing = await this.db.query<{ job_id: string }>(
          `SELECT job_id FROM job_outbox
           WHERE tenant_id IS NOT DISTINCT FROM $1
             AND job_type = $2
             AND idempotency_key = $3
           LIMIT 1`,
          [request.tenantId ?? null, request.jobType, request.idempotencyKey],
        );
        const found = existing.rows[0];
        if (found !== undefined) {
          return { jobId: found.job_id, jobType: request.jobType, deduplicated: true };
        }
      }
      throw error;
    }

    return { jobId, jobType: request.jobType, deduplicated: false };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}

/**
 * Claim up to `limit` due jobs for processing (SKIP LOCKED).
 * Expired LEASED rows are reclaimable.
 */
export async function claimDueJobs(
  db: Pool,
  input: {
    readonly owner: string;
    readonly limit?: number;
    readonly leaseMs?: number;
    readonly now?: Date;
  },
): Promise<readonly JobOutboxRow[]> {
  const limit = input.limit ?? 10;
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS;
  const now = input.now ?? new Date();
  const leasedUntil = new Date(now.getTime() + leaseMs);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{
      job_id: string;
      tenant_id: string | null;
      job_type: string;
      payload: JsonObject;
      idempotency_key: string | null;
      status: JobOutboxRow['status'];
      attempts: number;
      max_attempts: number;
      run_at: Date;
    }>(
      `SELECT job_id, tenant_id, job_type, payload, idempotency_key, status,
              attempts, max_attempts, run_at
       FROM job_outbox
       WHERE run_at <= $1
         AND (
           status = 'PENDING'
           OR (status = 'LEASED' AND leased_until IS NOT NULL AND leased_until < $1)
         )
       ORDER BY run_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [now.toISOString(), limit],
    );

    const claimed: JobOutboxRow[] = [];
    for (const row of selected.rows) {
      await client.query(
        `UPDATE job_outbox
         SET status = 'LEASED',
             attempts = attempts + 1,
             leased_until = $2,
             lease_owner = $3,
             updated_at = now()
         WHERE job_id = $1`,
        [row.job_id, leasedUntil.toISOString(), input.owner],
      );
      claimed.push({
        jobId: row.job_id,
        tenantId: row.tenant_id ?? undefined,
        jobType: row.job_type,
        payload: row.payload,
        idempotencyKey: row.idempotency_key ?? undefined,
        status: 'LEASED',
        attempts: row.attempts + 1,
        maxAttempts: row.max_attempts,
        runAt: row.run_at instanceof Date ? row.run_at : new Date(row.run_at),
      });
    }
    await client.query('COMMIT');
    return claimed;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function markJobSucceeded(db: Queryable, jobId: string): Promise<void> {
  await db.query(
    `UPDATE job_outbox
     SET status = 'SUCCEEDED',
         leased_until = NULL,
         lease_owner = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE job_id = $1`,
    [jobId],
  );
}

export async function markJobFailed(
  db: Queryable,
  input: {
    readonly jobId: string;
    readonly error: string;
    readonly retryDelayMs?: number;
    readonly now?: Date;
  },
): Promise<'PENDING' | 'DEAD_LETTER'> {
  const now = input.now ?? new Date();
  const current = await db.query<{ attempts: number; max_attempts: number }>(
    `SELECT attempts, max_attempts FROM job_outbox WHERE job_id = $1`,
    [input.jobId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    throw new Error(`job_outbox row not found: ${input.jobId}`);
  }

  if (row.attempts >= row.max_attempts) {
    await db.query(
      `UPDATE job_outbox
       SET status = 'DEAD_LETTER',
           leased_until = NULL,
           lease_owner = NULL,
           last_error = $2,
           updated_at = now()
       WHERE job_id = $1`,
      [input.jobId, input.error.slice(0, 2000)],
    );
    return 'DEAD_LETTER';
  }

  const delay = input.retryDelayMs ?? Math.min(60_000, 1000 * 2 ** Math.max(0, row.attempts - 1));
  const runAt = new Date(now.getTime() + delay);
  await db.query(
    `UPDATE job_outbox
     SET status = 'PENDING',
         run_at = $2,
         leased_until = NULL,
         lease_owner = NULL,
         last_error = $3,
         updated_at = now()
     WHERE job_id = $1`,
    [input.jobId, runAt.toISOString(), input.error.slice(0, 2000)],
  );
  return 'PENDING';
}
