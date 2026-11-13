/**
 * Claim/poll loop for the D-022 Postgres outbox.
 *
 * Usage: npm run jobs:work -- [--once] [--limit N]
 *
 * Runs against DATABASE_URL. Drains durable jobs enqueued by STAGING/PRODUCTION and
 * runs the time-driven sweeps; the loop itself is `runJobWorker` in src/jobs/worker.ts,
 * which the AWS Lambda handler (src/aws/job-worker-lambda.ts) shares.
 */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { runJobWorker } from '../jobs/worker.js';
import { installShutdown } from './shutdown.js';

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

async function main(): Promise<void> {
  const { once, limit } = parseArgs(process.argv.slice(2));
  const config = loadConfig(process.env);
  const pool = createPool(config);
  const stop = new AbortController();
  const run = runJobWorker({
    pool,
    config,
    owner: `job-worker:${process.pid}`,
    once,
    limit,
    signal: stop.signal,
  }).finally(() => pool.end());
  // A signal stops the loop after the batch in hand; leases on unfinished rows expire.
  installShutdown(async () => {
    stop.abort();
    await run;
  });
  await run;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
