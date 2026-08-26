/**
 * LOCAL/TEST job dispatch: run a handler after a successful enqueue.
 *
 * Completing a Check-In still only *requests* work (CHECKINS.md §6.3). This
 * wrapper is how that request is honoured in the non-durable seam while D-022
 * remains open. Handler failures are logged and do not fail the enqueue, so
 * CHECKIN_COMPLETED stays committed even when scoring refuses.
 */

import type { DurableJobQueuePort, EnqueuedJob, JobEnqueueRequest } from './port.js';

export type JobHandler = (request: JobEnqueueRequest) => Promise<void>;

export class DispatchingJobQueue implements DurableJobQueuePort {
  readonly durability: DurableJobQueuePort['durability'];
  readonly implementation: string;

  constructor(
    private readonly inner: DurableJobQueuePort,
    private readonly handlers: Readonly<Record<string, JobHandler>>,
    private readonly onHandlerError: (error: unknown, request: JobEnqueueRequest) => void = () => {
      /* tests replace this */
    },
  ) {
    this.durability = inner.durability;
    this.implementation = inner.implementation;
  }

  async enqueue(request: JobEnqueueRequest): Promise<EnqueuedJob> {
    const result = await this.inner.enqueue(request);
    if (result.deduplicated) return result;
    const handler = this.handlers[request.jobType];
    if (handler === undefined) return result;
    try {
      await handler(request);
    } catch (error) {
      this.onHandlerError(error, request);
    }
    return result;
  }
}
