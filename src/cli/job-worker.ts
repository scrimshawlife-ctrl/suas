/**
 * Claim/poll loop for the D-022 Postgres outbox.
 *
 * Usage: npm run jobs:work -- [--once] [--limit N]
 *
 * Runs against DATABASE_URL (unpooled Neon for Node). Does not replace the
 * Worker request path; it drains durable jobs enqueued by STAGING/PRODUCTION.
 */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { claimDueJobs, markJobFailed, markJobSucceeded, type JobOutboxRow } from '../jobs/index.js';
import { parseComputeJobPayload, runSupportSignalComputeJob } from '../signals/index.js';

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

async function handleJob(
  pool: ReturnType<typeof createPool>,
  config: ReturnType<typeof loadConfig>,
  job: JobOutboxRow,
): Promise<void> {
  if (job.jobType === 'support-signal.compute') {
    const parsed = parseComputeJobPayload(job.payload, job.tenantId);
    if (parsed === undefined) {
      throw new Error('invalid support-signal.compute payload');
    }
    await runSupportSignalComputeJob(pool, config, parsed);
    return;
  }
  // Unknown types stay leased until retry/DLQ so operators notice.
  throw new Error(`no handler registered for job type ${job.jobType}`);
}

async function main(): Promise<void> {
  const { once, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const pool = createPool(config);

  try {
    for (;;) {
      const claimed = await claimDueJobs(pool, { owner, limit });
      if (claimed.length === 0) {
        if (once) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
        continue;
      }

      for (const job of claimed) {
        try {
          await handleJob(pool, config, job);
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
