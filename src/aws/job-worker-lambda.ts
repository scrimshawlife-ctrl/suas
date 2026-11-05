/**
 * AWS Lambda entry for the scheduled job worker (V1_PROJECT_PLAN.md §2.2, §4.1 Jobs).
 *
 * EventBridge Scheduler invokes it; each invocation is one pass, equal to
 * `job-worker --once`: the time-driven sweeps (request widening), then one batch of
 * due outbox jobs. It never loops, so the Lambda timeout bounds the work. Any failure
 * to start or to talk to the database throws, which fails the invocation. A single
 * job that fails is recorded on its outbox row (retry, then dead letter) as in the CLI.
 *
 * The optional event `{ "limit": N }` overrides the batch size (default 10).
 */

import { loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { runJobWorker } from '../jobs/worker.js';

const DEFAULT_LIMIT = 10;

export interface JobWorkerLambdaEvent {
  readonly limit?: number;
}

export async function handler(
  event: JobWorkerLambdaEvent = {},
  context?: { readonly awsRequestId?: string },
): Promise<{ readonly passes: 1 }> {
  const limit =
    typeof event.limit === 'number' && Number.isInteger(event.limit) && event.limit > 0
      ? event.limit
      : DEFAULT_LIMIT;
  const config = loadConfig(process.env);
  const pool = createPool(config, 'node');
  try {
    await runJobWorker({
      pool,
      config,
      owner: `job-worker-lambda:${context?.awsRequestId ?? 'unknown'}`,
      once: true,
      limit,
    });
  } finally {
    await pool.end();
  }
  return { passes: 1 };
}
