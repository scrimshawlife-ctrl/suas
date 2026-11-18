/**
 * Durable Postgres outbox job queue: a local choice pending D-022 (DECISION_PENDING).
 *
 * Spec citations:
 * - ARCHITECTURE.md §3 invariant 5, §8, §10, §13, §16
 * - Decision packet D-022 (Postgres outbox / SKIP LOCKED; DECISION_PENDING)
 *
 * Enqueue writes a row that survives process restart. Workers claim due rows
 * with `FOR UPDATE SKIP LOCKED` via {@link claimDueJobs}. A claim is a lease held by
 * one owner; only the current holder may renew or settle it, so a worker whose lease
 * ran out and was reclaimed cannot run or settle the job again.
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

/**
 * The longest a deferred job waits. Today's deferrals are one send-claim window (45 s) or
 * less; the cap keeps a buggy delay from parking a job for years or overflowing the date.
 */
const MAX_DEFER_MS = 15 * 60_000;

/** When a deferred job is due: `delayMs` from now, held to 0..MAX_DEFER_MS (NaN counts as 0). */
function deferredRunAt(delayMs: number): string {
  const delay = Number.isNaN(delayMs) ? 0 : Math.min(Math.max(delayMs, 0), MAX_DEFER_MS);
  return new Date(Date.now() + delay).toISOString();
}

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
  /** Who holds the lease on a claimed row. */
  readonly leaseOwner: string;
}

/** A held lease. Owner and attempt number together fence it: a reclaim changes both. */
export type JobLease = Pick<JobOutboxRow, 'jobId' | 'leaseOwner' | 'attempts'>;

/** Matches the row only while `$2` (owner) and `$3` (attempts) still hold its lease. */
const LEASE_HELD = `job_id = $1 AND status = 'LEASED' AND lease_owner = $2 AND attempts = $3`;

function leaseParams(lease: JobLease): [string, string, number] {
  return [lease.jobId, lease.leaseOwner, lease.attempts];
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
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  return error.code === '23505';
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
    /** Claim only this job type. */
    readonly jobType?: string;
    /** Claim every type except these. */
    readonly exceptJobTypes?: readonly string[];
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
         AND ($3::text IS NULL OR job_type = $3)
         AND NOT (job_type = ANY($4::text[]))
       ORDER BY run_at ASC, created_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2`,
      [now.toISOString(), limit, input.jobType ?? null, input.exceptJobTypes ?? []],
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
        leaseOwner: input.owner,
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

/**
 * Lease one PENDING job for an inline run in the process that enqueued it, so workers
 * skip it meanwhile. Undefined when a worker already took it. An inline run is not an
 * outbox attempt, so `attempts` is unchanged.
 */
async function leaseJob(
  db: Queryable,
  input: { readonly jobId: string; readonly owner: string },
): Promise<JobLease | undefined> {
  const now = new Date();
  const leasedUntil = new Date(now.getTime() + DEFAULT_LEASE_MS);
  const result = await db.query<{ attempts: number }>(
    `UPDATE job_outbox
     SET status = 'LEASED', leased_until = $3, lease_owner = $2, updated_at = now()
     WHERE job_id = $1 AND status = 'PENDING' AND run_at <= $4
     RETURNING attempts`,
    [input.jobId, input.owner, leasedUntil.toISOString(), now.toISOString()],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { jobId: input.jobId, leaseOwner: input.owner, attempts: row.attempts };
}

/**
 * Restart a held lease's clock just before its job runs, so a job that waited behind
 * others in a batch starts with a full lease. False when another worker reclaimed it:
 * the caller must then skip the job.
 */
export async function renewJobLease(
  db: Queryable,
  lease: JobLease,
  options: { readonly leaseMs?: number } = {},
): Promise<boolean> {
  const leasedUntil = new Date(Date.now() + (options.leaseMs ?? DEFAULT_LEASE_MS));
  const result = await db.query(
    `UPDATE job_outbox SET leased_until = $4, updated_at = now() WHERE ${LEASE_HELD}`,
    [...leaseParams(lease), leasedUntil.toISOString()],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Run `work` while renewing the lease every third of `leaseMs`, so a job that runs past
 * its lease is not reclaimed. Renewal stops once the lease is lost; the owner-checked
 * settle then refuses this runner. A failed renewal query is retried on the next beat.
 */
export async function holdJobLease<T>(
  db: Queryable,
  lease: JobLease,
  work: () => Promise<T>,
  options: { readonly leaseMs?: number } = {},
): Promise<T> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  let renewing: Promise<unknown> = Promise.resolve();
  const beat = setInterval(
    () => {
      renewing = renewJobLease(db, lease, { leaseMs }).then(
        (held) => {
          if (!held) clearInterval(beat);
        },
        () => undefined,
      );
    },
    Math.max(1, Math.floor(leaseMs / 3)),
  );
  beat.unref();
  try {
    return await work();
  } finally {
    clearInterval(beat);
    await renewing;
  }
}

/** Put a held job back to PENDING after `delayMs`, giving back the attempt its claim took. */
export async function deferJob(db: Queryable, lease: JobLease, delayMs: number): Promise<boolean> {
  const result = await db.query(
    `UPDATE job_outbox
     SET status = 'PENDING', attempts = GREATEST(attempts - 1, 0), run_at = $4,
         leased_until = NULL, lease_owner = NULL, updated_at = now()
     WHERE ${LEASE_HELD}`,
    [...leaseParams(lease), deferredRunAt(delayMs)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Reopen a job this runner just dead-lettered, due after `delayMs`, giving back its last attempt. */
export async function reopenDeadLetter(
  db: Queryable,
  job: Pick<JobOutboxRow, 'jobId' | 'attempts'>,
  delayMs: number,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE job_outbox
     SET status = 'PENDING', attempts = GREATEST(attempts - 1, 0), run_at = $3, updated_at = now()
     WHERE job_id = $1 AND status = 'DEAD_LETTER' AND attempts = $2`,
    [job.jobId, job.attempts, deferredRunAt(delayMs)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Hand a held job back to PENDING, due now, without counting a failure. */
async function releaseJob(db: Queryable, lease: JobLease): Promise<void> {
  await db.query(
    `UPDATE job_outbox
     SET status = 'PENDING', leased_until = NULL, lease_owner = NULL, updated_at = now()
     WHERE ${LEASE_HELD}`,
    leaseParams(lease),
  );
}

/**
 * Run a just-enqueued job inline under a lease: done on success, released for a worker
 * on failure (the error is rethrown). Skipped when a worker holds it already.
 */
export async function runJobUnderLease(
  db: Queryable,
  input: { readonly jobId: string; readonly owner: string },
  run: () => Promise<void>,
): Promise<void> {
  const lease = await leaseJob(db, input);
  if (lease === undefined) return;
  try {
    await holdJobLease(db, lease, run);
  } catch (error) {
    await releaseJob(db, lease);
    throw error;
  }
  await markJobSucceeded(db, lease);
}

/** Settle a held job as done. False when the lease was lost: the new holder settles it. */
export async function markJobSucceeded(db: Queryable, lease: JobLease): Promise<boolean> {
  const result = await db.query(
    `UPDATE job_outbox
     SET status = 'SUCCEEDED',
         leased_until = NULL,
         lease_owner = NULL,
         last_error = NULL,
         updated_at = now()
     WHERE ${LEASE_HELD}`,
    leaseParams(lease),
  );
  return (result.rowCount ?? 0) > 0;
}

/** Settle a held job as failed: retried with backoff, or dead-lettered once exhausted. */
export async function markJobFailed(
  db: Queryable,
  input: {
    readonly lease: JobLease;
    readonly error: string;
    readonly retryDelayMs?: number;
    readonly now?: Date;
  },
): Promise<'PENDING' | 'DEAD_LETTER' | 'LEASE_LOST'> {
  const now = input.now ?? new Date();
  const params = leaseParams(input.lease);
  const current = await db.query<{ attempts: number; max_attempts: number }>(
    `SELECT attempts, max_attempts FROM job_outbox WHERE ${LEASE_HELD}`,
    params,
  );
  const row = current.rows[0];
  if (row === undefined) return 'LEASE_LOST';

  if (row.attempts >= row.max_attempts) {
    const dead = await db.query(
      `UPDATE job_outbox
       SET status = 'DEAD_LETTER',
           leased_until = NULL,
           lease_owner = NULL,
           last_error = $4,
           updated_at = now()
       WHERE ${LEASE_HELD}`,
      [...params, input.error.slice(0, 2000)],
    );
    return (dead.rowCount ?? 0) > 0 ? 'DEAD_LETTER' : 'LEASE_LOST';
  }

  const delay = input.retryDelayMs ?? Math.min(60_000, 1000 * 2 ** Math.max(0, row.attempts - 1));
  const runAt = new Date(now.getTime() + delay);
  const retried = await db.query(
    `UPDATE job_outbox
     SET status = 'PENDING',
         run_at = $4,
         leased_until = NULL,
         lease_owner = NULL,
         last_error = $5,
         updated_at = now()
     WHERE ${LEASE_HELD}`,
    [...params, runAt.toISOString(), input.error.slice(0, 2000)],
  );
  return (retried.rowCount ?? 0) > 0 ? 'PENDING' : 'LEASE_LOST';
}
