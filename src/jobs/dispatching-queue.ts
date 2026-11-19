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
     * Runs the handler for an enqueued job. A durable queue passes one that leases the
     * row first, so the job worker skips it while it runs, marks it done after, and
     * skips the inline run when a worker holds it already. Default: run it directly.
     */
    private readonly runInline: (job: EnqueuedJob, run: () => Promise<void>) => Promise<void> = (
      _job,
      run,
    ) => run(),
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
      await this.runInline(result, () => handler(request));
    } catch (error) {
      this.onHandlerError(error, request);
    }
    return result;
  }
}
