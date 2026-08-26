import { describe, expect, it } from 'vitest';
import { DispatchingJobQueue, InMemoryJobQueue } from '../../src/jobs/index.js';

describe('DispatchingJobQueue', () => {
  it('runs the matching handler after a new enqueue', async () => {
    const inner = new InMemoryJobQueue();
    const seen: string[] = [];
    const queue = new DispatchingJobQueue(inner, {
      'support-signal.compute': (request) => {
        const id = request.payload.check_in_id;
        if (typeof id === 'string') seen.push(id);
        return Promise.resolve();
      },
    });
    await queue.enqueue({
      jobType: 'support-signal.compute',
      payload: { check_in_id: 'c1' },
      tenantId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'support-signal:c1',
    });
    expect(seen).toEqual(['c1']);
    expect(inner.enqueued()).toHaveLength(1);
  });

  it('does not re-run a deduplicated enqueue', async () => {
    const inner = new InMemoryJobQueue();
    let calls = 0;
    const queue = new DispatchingJobQueue(inner, {
      'support-signal.compute': () => {
        calls += 1;
        return Promise.resolve();
      },
    });
    const request = {
      jobType: 'support-signal.compute',
      payload: { check_in_id: 'c1' },
      tenantId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: 'support-signal:c1',
    };
    await queue.enqueue(request);
    await queue.enqueue(request);
    expect(calls).toBe(1);
  });

  it('does not fail the enqueue when the handler throws', async () => {
    const inner = new InMemoryJobQueue();
    const errors: unknown[] = [];
    const queue = new DispatchingJobQueue(
      inner,
      {
        'support-signal.compute': () => Promise.reject(new Error('scoring refused')),
      },
      (error) => {
        errors.push(error);
      },
    );
    const result = await queue.enqueue({
      jobType: 'support-signal.compute',
      payload: { check_in_id: 'c1' },
      tenantId: '00000000-0000-4000-8000-000000000001',
    });
    expect(result.deduplicated).toBe(false);
    expect(errors).toHaveLength(1);
  });
});
