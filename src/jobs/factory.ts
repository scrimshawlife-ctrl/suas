/**
 * Durable job queue selection.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §8 (D-022 = Postgres outbox, DECIDED 2026-08-26)
 * - SUAS-specs ARCHITECTURE.md §3 invariant 5
 * - SUAS-specs ENVIRONMENT.md §4–§5 (fail closed)
 */

import type { Pool } from 'pg';
import type { SuasConfig } from '../config/index.js';
import { InMemoryJobQueue } from './in-memory-queue.js';
import type { DurableJobQueuePort } from './port.js';
import { PostgresOutboxJobQueue } from './postgres-outbox-queue.js';

export class DurableJobQueueUnavailableError extends Error {
  constructor(environment: string, detail: string) {
    super(
      `No durable job queue is available for ${environment}: ${detail}. ` +
        `D-022 chose Postgres outbox; STAGING/PRODUCTION require a database pool ` +
        `(ARCHITECTURE.md §3 invariant 5, §8).`,
    );
    this.name = 'DurableJobQueueUnavailableError';
  }
}

export interface CreateJobQueueOptions {
  /** Required for durable Postgres outbox. */
  readonly pool?: Pool;
  /**
   * LOCAL/TEST override. Default: in-memory fake.
   * Set `postgres-outbox` to exercise the durable adapter against a pool.
   */
  readonly localImplementation?: 'in-memory-fake' | 'postgres-outbox';
}

/**
 * Return the job queue for this environment.
 *
 * - LOCAL/TEST: in-memory fake by default (or postgres-outbox when requested).
 * - STAGING/PRODUCTION: Postgres outbox (requires pool).
 */
export function createJobQueue(
  config: SuasConfig,
  options: CreateJobQueueOptions = {},
): DurableJobQueuePort {
  const env = config.environment;

  if (env === 'LOCAL' || env === 'TEST') {
    const impl = options.localImplementation ?? 'in-memory-fake';
    if (impl === 'postgres-outbox') {
      if (options.pool === undefined) {
        throw new DurableJobQueueUnavailableError(env, 'postgres-outbox requested without a pool');
      }
      return new PostgresOutboxJobQueue(options.pool);
    }
    return new InMemoryJobQueue();
  }

  if (options.pool === undefined) {
    throw new DurableJobQueueUnavailableError(env, 'DATABASE_URL / pool is required');
  }
  return new PostgresOutboxJobQueue(options.pool);
}
