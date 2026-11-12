/**
 * Claim/poll loop for the Postgres outbox (local choice pending D-022), shared by the
 * `job-worker` CLI and the AWS Lambda handler so there is one implementation.
 *
 * Each pass also runs the time-driven sweeps that no request enqueues work for (see
 * `SWEEPS`), so a scheduler running one pass (`once`) is the only schedule needed.
 */

import type { Pool } from 'pg';
import {
  CHALLENGE_ISSUE_WINDOW_SECONDS,
  CHALLENGE_VERIFY_WINDOW_SECONDS,
  pruneRateLimits,
} from '../auth/index.js';
import type { SuasConfig } from '../config/index.js';
import { expireDueGrants } from '../consent/index.js';
import { expireDueRequests } from '../coordination/expiry.js';
import { repairMissedRequestNotices } from '../coordination/request-notices.js';
import { widenDueRequests } from '../coordination/widening.js';
import { assertExpectedSchemaVersion, withTransaction } from '../db/index.js';
import { createChannelRegistry, deliverQueuedInApp } from '../notifications/index.js';
import { claimDueWork, markFollowUpDue } from '../settlement/index.js';
import { abandonStaleCheckIns } from '../signals/index.js';
import {
  claimDueJobs,
  markJobFailed,
  markJobSucceeded,
  PostgresOutboxJobQueue,
  type JobOutboxRow,
} from './postgres-outbox-queue.js';
import {
  createDeadLetterHandlers,
  createJobHandlers,
  type DeadLetterWork,
  type JobWork,
} from './handlers.js';

export interface JobWorkerOptions {
  readonly pool: Pool;
  readonly config: SuasConfig;
  /** Lease owner recorded on claimed rows. */
  readonly owner: string;
  /** One pass (sweeps plus one claim batch), then return. Otherwise loop until stopped. */
  readonly once: boolean;
  readonly limit: number;
  /** Once aborted, the current batch finishes and no new pass starts. */
  readonly signal?: AbortSignal;
}

const IDLE_POLL_MS = 2000;

/** Counters older than the longest rate-limit window can no longer limit anything. */
const RATE_LIMIT_RETENTION_SECONDS = Math.max(
  CHALLENGE_ISSUE_WINDOW_SECONDS.value,
  CHALLENGE_VERIFY_WINDOW_SECONDS.value,
);

function log(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

function logError(record: Record<string, unknown>): void {
  console.error(JSON.stringify(record));
}

interface Sweep {
  readonly name: string;
  run(pool: Pool): Promise<void>;
}

const SWEEPS: readonly Sweep[] = [
  // Request widening (V1_PROJECT_PLAN.md F6).
  {
    name: 'widening',
    run: async (pool) => {
      const { widened, delayMinutes } = await widenDueRequests(pool);
      for (const request of widened) {
        log({
          msg: 'request_widened',
          service_request_id: request.serviceRequestId,
          from_county: request.fromCounty,
          reached_counties: request.reachedCounties,
          delay_minutes: delayMinutes,
        });
      }
    },
  },
  // Request expiry (R8.4, DISPATCH.md §14.6).
  {
    name: 'expiry',
    run: async (pool) => {
      const { expired, ttlHours, noticeFailures } = await expireDueRequests(pool);
      for (const request of expired) {
        log({
          msg: 'request_expired',
          service_request_id: request.serviceRequestId,
          ttl_hours: ttlHours,
        });
      }
      if (noticeFailures > 0) {
        logError({ msg: 'sweep_notice_failed', sweep: 'expiry', failed: noticeFailures });
      }
    },
  },
  // Expiry and release notices whose post-commit write failed (DISPATCH.md §14.6, §14.7).
  {
    name: 'request_notice_repair',
    run: async (pool) => {
      const { repaired, failed } = await repairMissedRequestNotices(pool);
      if (repaired > 0) log({ msg: 'request_notices_repaired', count: repaired });
      if (failed > 0) logError({ msg: 'sweep_notice_failed', sweep: 'notice_repair', failed });
    },
  },
  // IN_APP rows left QUEUED by earlier builds (NOTIFICATIONS.md §6).
  {
    name: 'in_app_delivery',
    run: async (pool) => {
      const delivered = await deliverQueuedInApp(pool);
      if (delivered > 0) log({ msg: 'in_app_delivered', count: delivered });
    },
  },
  // Check-In idle sweep (R8.10).
  {
    name: 'check_in_idle',
    run: async (pool) => {
      const { abandoned } = await abandonStaleCheckIns(pool);
      if (abandoned > 0) log({ msg: 'check_ins_abandoned', count: abandoned });
    },
  },
  // Follow-Up due work (FOLLOWUP.md §5, §9): one FOLLOWUP_DUE per schedule version.
  {
    name: 'follow_up_due',
    run: async (pool) => {
      let marked = 0;
      for (const { tenantId, item } of await claimDueWork(pool)) {
        if ((await markFollowUpDue(pool, tenantId, item)).transitioned) marked += 1;
      }
      if (marked > 0) log({ msg: 'follow_ups_due', count: marked });
    },
  },
  // Grants past expires_at become EXPIRED with their ConsentEvent (CONSENT.md §7, §8).
  {
    name: 'consent_expiry',
    run: async (pool) => {
      const expired = await withTransaction(pool, (tx) => expireDueGrants(tx));
      if (expired > 0) log({ msg: 'consent_grants_expired', count: expired });
    },
  },
  // Elapsed rate-limit windows (AUTH.md §3): abuse-control state, not records.
  {
    name: 'rate_limit_prune',
    run: async (pool) => {
      const pruned = await pruneRateLimits(pool, RATE_LIMIT_RETENTION_SECONDS);
      if (pruned > 0) log({ msg: 'rate_limits_pruned', count: pruned });
    },
  },
];

/**
 * A failed sweep is logged and does not stop the others or the outbox drain: the next
 * pass repeats it, and each sweep is idempotent.
 */
async function runSweeps(pool: Pool): Promise<void> {
  for (const sweep of SWEEPS) {
    try {
      await sweep.run(pool);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logError({ msg: 'sweep_failed', sweep: sweep.name, error: message });
    }
  }
}

async function handleJob(
  handlers: Readonly<Record<string, JobWork>>,
  job: JobOutboxRow,
): Promise<void> {
  const handler = handlers[job.jobType];
  // Unknown types stay leased until retry/DLQ so operators notice.
  if (handler === undefined) {
    throw new Error(`no handler registered for job type ${job.jobType}`);
  }
  await handler(job);
}

async function settleDeadLetter(
  handlers: Readonly<Record<string, DeadLetterWork>>,
  job: JobOutboxRow,
  lastError: string,
): Promise<void> {
  const handler = handlers[job.jobType];
  if (handler === undefined) return;
  try {
    await handler(job, lastError);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logError({
      msg: 'job_failed',
      job_id: job.jobId,
      job_type: job.jobType,
      status: 'DEAD_LETTER_SETTLE_FAILED',
      error: message.slice(0, 300),
    });
  }
}

/** Waits `ms`, or less when the signal aborts, without leaving a listener behind. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function runJobWorker(options: JobWorkerOptions): Promise<void> {
  const { pool, config, owner, once, limit, signal } = options;
  // ENVIRONMENT.md §9: refuse a schema this build cannot operate against before any work.
  await assertExpectedSchemaVersion(pool);

  const outbox = new PostgresOutboxJobQueue(pool);
  const handlers = createJobHandlers({
    pool,
    config,
    channels: createChannelRegistry(config),
    getJobQueue: () => outbox,
  });
  const deadLetterHandlers = createDeadLetterHandlers(pool);

  while (signal?.aborted !== true) {
    await runSweeps(pool);
    const claimed = await claimDueJobs(pool, { owner, limit });
    if (claimed.length === 0) {
      if (once) break;
      await pause(IDLE_POLL_MS, signal);
      continue;
    }

    for (const job of claimed) {
      try {
        await handleJob(handlers, job);
        await markJobSucceeded(pool, job.jobId);
        log({
          msg: 'job_succeeded',
          job_id: job.jobId,
          job_type: job.jobType,
          attempts: job.attempts,
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const status = await markJobFailed(pool, { jobId: job.jobId, error: message });
        logError({
          msg: 'job_failed',
          job_id: job.jobId,
          job_type: job.jobType,
          status,
          error: message.slice(0, 300),
        });
        if (status === 'DEAD_LETTER') await settleDeadLetter(deadLetterHandlers, job, message);
      }
    }

    if (once) break;
  }
}
