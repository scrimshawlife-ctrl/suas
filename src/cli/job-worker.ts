/**
 * Claim/poll loop for the D-022 Postgres outbox.
 *
 * Usage: npm run jobs:work -- [--once] [--limit N]
 *
 * Runs against DATABASE_URL (unpooled Neon for Node). Does not replace the
 * Worker request path; it drains durable jobs enqueued by STAGING/PRODUCTION.
 *
 * Each pass also runs the time-driven sweeps that no request enqueues work for.
 * Today that is request widening (V1_PROJECT_PLAN.md F6), so the scheduler's
 * `job-worker --once` is the only schedule that has to exist.
 */

import { loadConfig } from '../config/index.js';
import { widenDueRequests } from '../coordination/widening.js';
import { createPool } from '../db/index.js';
import {
  claimDueJobs,
  markJobFailed,
  markJobSucceeded,
  PostgresOutboxJobQueue,
  type JobOutboxRow,
} from '../jobs/index.js';
import {
  notificationSendHandler,
  supportSignalComputeHandler,
  type JobWork,
} from '../jobs/handlers.js';
import { createChannelRegistry } from '../notifications/index.js';

const owner = `job-worker:${process.pid}`;

function parseArgs(argv: readonly string[]): { once: boolean; limit: number } {
  let once = false;
  let limit = 10;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--once') once = true;
    if (arg === '--limit') {
      const next = argv[i + 1];
      if (next !== undefined) {
        limit = Number(next);
        i += 1;
      }
    }
  }
  return { once, limit: Number.isFinite(limit) && limit > 0 ? limit : 10 };
}

function createHandlers(
  pool: ReturnType<typeof createPool>,
  config: ReturnType<typeof loadConfig>,
): Readonly<Record<string, JobWork>> {
  const outbox = new PostgresOutboxJobQueue(pool);
  return {
    // RED alerts enqueue notification.send rows that a later poll delivers.
    'support-signal.compute': supportSignalComputeHandler(pool, config, () => outbox),
    'notification.send': notificationSendHandler(pool, createChannelRegistry(config)),
  };
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
 * repeats it, and widening is idempotent.
 */
async function runSweeps(pool: ReturnType<typeof createPool>): Promise<void> {
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
}

async function main(): Promise<void> {
  const { once, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const pool = createPool(config);
  const handlers = createHandlers(pool, config);

  try {
    for (;;) {
      await runSweeps(pool);
      const claimed = await claimDueJobs(pool, { owner, limit });
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
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
