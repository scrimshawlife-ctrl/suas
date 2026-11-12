/**
 * Claim/poll loop for the D-022 Postgres outbox, shared by the `job-worker` CLI and
 * the AWS Lambda handler so there is one implementation.
 *
 * Each pass also runs the time-driven sweeps that no request enqueues work for. Today
 * that is request widening (V1_PROJECT_PLAN.md F6), request expiry (R8.4), the Check-In
 * idle sweep (R8.10) and the licence PHOTOS_EXPIRED sweep (R10.1 §2.3), so a scheduler
 * running one pass (`once`) is the only schedule needed.
 */

import type { Pool } from 'pg';
import type { SuasConfig } from '../config/index.js';
import { expireDueRequests } from '../coordination/expiry.js';
import { widenDueRequests } from '../coordination/widening.js';
import {
  expireOldReviews,
  LICENCE_CLOSE_JOB_TYPE,
  LICENCE_READ_JOB_TYPE,
} from '../identity/licence-review.js';
import { createObjectStoragePort } from '../storage/index.js';
import { createChannelRegistry } from '../notifications/index.js';
import { abandonStaleCheckIns } from '../signals/index.js';
import {
  claimDueJobs,
  markJobFailed,
  markJobSucceeded,
  PostgresOutboxJobQueue,
  type JobOutboxRow,
} from './postgres-outbox-queue.js';
import {
  licenceCloseHandler,
  licenceReadHandler,
  notificationSendHandler,
  supportSignalComputeHandler,
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
}

function createHandlers(pool: Pool, config: SuasConfig): Readonly<Record<string, JobWork>> {
  const outbox = new PostgresOutboxJobQueue(pool);
  return {
    // RED alerts enqueue notification.send rows that a later poll delivers.
    'support-signal.compute': supportSignalComputeHandler(pool, config, () => outbox),
    'notification.send': notificationSendHandler(pool, createChannelRegistry(config)),
    [LICENCE_READ_JOB_TYPE]: licenceReadHandler(pool, config),
    [LICENCE_CLOSE_JOB_TYPE]: licenceCloseHandler(pool, config),
  };
}

/**
 * Job types capped per pass, with their lease. One licence read (a reader call of up to
 * 75 s) per pass keeps a pass inside the 2-minute worker; its lease outlasts the worker,
 * so an overlapping pass cannot claim the same read again.
 */
export const PER_PASS_JOB_LIMITS: Readonly<Record<string, { limit: number; leaseMs: number }>> = {
  [LICENCE_READ_JOB_TYPE]: { limit: 1, leaseMs: 150_000 },
};

/** One pass's batch: up to `limit` uncapped jobs, plus each capped type up to its cap. */
async function claimPass(pool: Pool, owner: string, limit: number): Promise<JobOutboxRow[]> {
  const capped = Object.entries(PER_PASS_JOB_LIMITS);
  const claimed = [
    ...(await claimDueJobs(pool, { owner, limit, exceptJobTypes: capped.map(([type]) => type) })),
  ];
  for (const [jobType, cap] of capped) {
    claimed.push(...(await claimDueJobs(pool, { owner, jobType, ...cap })));
  }
  return claimed;
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

/**
 * A failed sweep is logged and does not stop the outbox drain: the next pass
 * repeats it, and each sweep is idempotent.
 */
async function runSweeps(pool: Pool, config: SuasConfig): Promise<void> {
  try {
    const { widened, delayMinutes } = await widenDueRequests(pool);
    for (const request of widened) {
      console.log(
        JSON.stringify({
          msg: 'request_widened',
          service_request_id: request.serviceRequestId,
          from_county: request.fromCounty,
          reached_counties: request.reachedCounties,
          delay_minutes: delayMinutes,
        }),
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: 'sweep_failed', sweep: 'widening', error: message }));
  }

  try {
    const { expired, ttlHours, noticeFailures } = await expireDueRequests(pool);
    for (const request of expired) {
      console.log(
        JSON.stringify({
          msg: 'request_expired',
          service_request_id: request.serviceRequestId,
          ttl_hours: ttlHours,
        }),
      );
    }
    if (noticeFailures > 0) {
      console.error(
        JSON.stringify({ msg: 'sweep_notice_failed', sweep: 'expiry', failed: noticeFailures }),
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: 'sweep_failed', sweep: 'expiry', error: message }));
  }

  try {
    const { abandoned } = await abandonStaleCheckIns(pool);
    if (abandoned > 0) {
      console.log(JSON.stringify({ msg: 'check_ins_abandoned', count: abandoned }));
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: 'sweep_failed', sweep: 'check_in_idle', error: message }));
  }

  try {
    const expired = await expireOldReviews({ pool, storage: createObjectStoragePort(config) });
    if (expired > 0)
      console.log(JSON.stringify({ msg: 'licence_reviews_expired', count: expired }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ msg: 'sweep_failed', sweep: 'licence_expiry', error: message }));
  }
}

export async function runJobWorker(options: JobWorkerOptions): Promise<void> {
  const { pool, config, owner, once, limit } = options;
  const handlers = createHandlers(pool, config);

  for (;;) {
    await runSweeps(pool, config);
    const claimed = await claimPass(pool, owner, limit);
    if (claimed.length === 0) {
      if (once) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }

    for (const job of claimed) {
      try {
        await handleJob(handlers, job);
        await markJobSucceeded(pool, job.jobId);
        console.log(
          JSON.stringify({
            msg: 'job_succeeded',
            job_id: job.jobId,
            job_type: job.jobType,
            attempts: job.attempts,
          }),
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const status = await markJobFailed(pool, { jobId: job.jobId, error: message });
        console.error(
          JSON.stringify({
            msg: 'job_failed',
            job_id: job.jobId,
            job_type: job.jobType,
            status,
            error: message.slice(0, 300),
          }),
        );
      }
    }

    if (once) break;
  }
}
