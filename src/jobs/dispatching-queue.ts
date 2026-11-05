/**
 * Inline job dispatch: run a handler right after a successful enqueue.
 *
 * Completing a Check-In still only *requests* work (CHECKINS.md §6.3). This
 * wrapper is how that request is honoured promptly. Handler failures are logged
 * and do not fail the enqueue, so CHECKIN_COMPLETED stays committed even when
 * scoring refuses; a durable row then stays pending for the job worker.
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
    /**
     * Called after the handler succeeds, so a durable queue can mark the row
     * done and the job worker does not run it a second time. When this fails
     * the row stays pending and the worker replays it, which handlers tolerate.
     */
    private readonly onHandled?: (job: EnqueuedJob) => Promise<void>,
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
      await this.onHandled?.(result);
    } catch (error) {
      this.onHandlerError(error, request);
    }
    return result;
  }
}
