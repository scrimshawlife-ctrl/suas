/**
 * Conformance expectations for any DurableJobQueuePort implementation.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §3 invariants 4–5, §8, §10, §16
 * - SUAS-specs HANDOFF.md §3 (fake while D-022 undecided)
 *
 * A future durable vendor selected under D-022 must satisfy these behaviors.
 * The in-memory fake proves the seam; it does not claim durability.
 */

import type { DurableJobQueuePort } from './port.js';

export interface JobPortConformanceResult {
  readonly implementation: string;
  readonly durability: DurableJobQueuePort['durability'];
  readonly checks: readonly { readonly name: string; readonly passed: true }[];
}

/**
 * Exercise the port contract. Throws on the first violated expectation.
 * Callers that need a durable queue must additionally assert
 * `queue.durability === 'durable'` — this suite intentionally accepts either.
 */
export async function assertJobPortConformance(
  queue: DurableJobQueuePort,
): Promise<JobPortConformanceResult> {
  const checks: { name: string; passed: true }[] = [];

  if (queue.implementation.trim() === '') {
    throw new Error('job queue must declare a non-empty implementation name');
  }
  checks.push({ name: 'declares_implementation', passed: true });

  if (queue.durability !== 'durable' && queue.durability !== 'non-durable') {
    throw new Error(
      `job queue durability must be durable|non-durable (got ${String(queue.durability)})`,
    );
  }
  checks.push({ name: 'declares_durability', passed: true });

  const first = await queue.enqueue({
    jobType: 'conformance.distinct',
    payload: { n: 1 },
    tenantId: 'conformance-t1',
  });
  const second = await queue.enqueue({
    jobType: 'conformance.distinct',
    payload: { n: 2 },
    tenantId: 'conformance-t1',
  });
  if (first.deduplicated || second.deduplicated || first.jobId === second.jobId) {
    throw new Error('distinct enqueues without an idempotency key must receive distinct job ids');
  }
  checks.push({ name: 'distinct_work_gets_distinct_ids', passed: true });

  const key = `conformance-${first.jobId}`;
  const original = await queue.enqueue({
    jobType: 'conformance.idempotent',
    payload: { step: 'a' },
    idempotencyKey: key,
    tenantId: 'conformance-t1',
  });
  const replay = await queue.enqueue({
    jobType: 'conformance.idempotent',
    payload: { step: 'a' },
    idempotencyKey: key,
    tenantId: 'conformance-t1',
  });
  if (!replay.deduplicated || replay.jobId !== original.jobId) {
    throw new Error('replayed idempotency key must reuse the original job id');
  }
  checks.push({ name: 'idempotency_key_deduplicates', passed: true });

  const otherTenant = await queue.enqueue({
    jobType: 'conformance.idempotent',
    payload: { step: 'a' },
    idempotencyKey: key,
    tenantId: 'conformance-t2',
  });
  if (otherTenant.deduplicated || otherTenant.jobId === original.jobId) {
    throw new Error('idempotency keys must be tenant-scoped');
  }
  checks.push({ name: 'idempotency_is_tenant_scoped', passed: true });

  return {
    implementation: queue.implementation,
    durability: queue.durability,
    checks,
  };
}
