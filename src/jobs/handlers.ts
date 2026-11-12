/**
 * Handlers for durable job types, shared by the inline dispatcher and the
 * job worker so one job type has one implementation.
 *
 * A handler resolves when the job is finished and throws when it must be
 * retried. Invalid payloads throw: the job stays visible and ends in
 * DEAD_LETTER instead of being marked done.
 */

import type { Pool } from 'pg';
import { z } from 'zod';
import type { SuasConfig } from '../config/index.js';
import { appendDomainEvent } from '../events/index.js';
import {
  attemptSend,
  parseNotificationSendPayload,
  settleUndeliverable,
  type NotificationChannel,
  type NotificationChannelPort,
} from '../notifications/index.js';
import { parseComputeJobPayload, runSupportSignalComputeJob } from '../signals/index.js';
import type { DurableJobQueuePort, JsonObject } from './port.js';

export interface JobToHandle {
  readonly jobType: string;
  readonly payload: JsonObject;
  readonly tenantId?: string | undefined;
}
export type JobWork = (job: JobToHandle) => Promise<void>;
/** Runs once a job is dead-lettered, to settle the record it was working on. */
export type DeadLetterWork = (job: JobToHandle, lastError: string) => Promise<void>;

export interface JobHandlerDeps {
  readonly pool: Pool;
  readonly config: SuasConfig;
  readonly channels: Map<NotificationChannel, NotificationChannelPort>;
  /** See {@link supportSignalComputeHandler}: the queue may wrap these handlers. */
  readonly getJobQueue: () => DurableJobQueuePort | undefined;
}

/** The job-type → handler map, built once for both the inline dispatcher and the job worker. */
export function createJobHandlers(deps: JobHandlerDeps): Readonly<Record<string, JobWork>> {
  return {
    // RED alerts enqueue notification.send rows that a later pass delivers.
    'support-signal.compute': supportSignalComputeHandler(deps.pool, deps.config, deps.getJobQueue),
    'notification.send': notificationSendHandler(deps.pool, deps.channels),
  };
}

/** Dead-letter follow-ups per job type, so an exhausted job never leaves its record pending. */
export function createDeadLetterHandlers(pool: Pool): Readonly<Record<string, DeadLetterWork>> {
  return { 'notification.send': notificationDeadLetterHandler(pool) };
}

const deadLetterNotificationPayload = z.object({ notification_id: z.string().uuid() });

/**
 * NOTIFICATIONS.md §5: failures thrown before any provider attempt (channel unavailable,
 * template error) never count as attempts, so the outbox exhausts first. The Notification
 * then settles UNDELIVERABLE instead of staying QUEUED.
 */
function notificationDeadLetterHandler(pool: Pool): DeadLetterWork {
  return async (job, lastError) => {
    const parsed = deadLetterNotificationPayload.safeParse(job.payload);
    if (!parsed.success || job.tenantId === undefined) return;
    await settleUndeliverable(pool, {
      tenantId: job.tenantId,
      notificationId: parsed.data.notification_id,
      failureReason: lastError,
    });
  };
}

/**
 * `getJobQueue` is a thunk because the inline dispatcher that wraps this handler
 * is itself the queue it needs to enqueue `notification.send` on.
 */
export function supportSignalComputeHandler(
  pool: Pool,
  config: SuasConfig,
  getJobQueue: () => DurableJobQueuePort | undefined = () => undefined,
): JobWork {
  return async (job) => {
    const parsed = parseComputeJobPayload(job.payload, job.tenantId);
    if (parsed === undefined) {
      throw new Error('invalid support-signal.compute payload');
    }
    await runSupportSignalComputeJob(pool, config, parsed, { jobQueue: getJobQueue() });
  };
}

/**
 * Delivers one Notification. Replay-safe: `attemptSend` skips a Notification
 * that is already SENT, terminal or cancelled, so a redelivered or
 * lease-expired job cannot send twice. A refused attempt (FAILED) throws so the
 * outbox retries it; once attempts are exhausted the Notification is
 * UNDELIVERABLE, which is a settled outcome and finishes the job.
 */
export function notificationSendHandler(
  pool: Pool,
  channels: Map<NotificationChannel, NotificationChannelPort>,
): JobWork {
  return async (job) => {
    const parsed = parseNotificationSendPayload(job.payload, job.tenantId);
    if (parsed === undefined || job.tenantId === undefined) {
      throw new Error('invalid notification.send payload');
    }
    const result = await attemptSend(pool, channels, {
      tenantId: job.tenantId,
      notificationId: parsed.notificationId,
      disclosure: parsed.disclosure,
    });
    if (result.notification.deliveryStatus === 'FAILED') {
      throw new Error(`notification send failed: ${result.reason ?? 'provider refused'}`);
    }
    // SAFETY.md §3.4: TRUSTED_CONTACT_ALERTED only when a send actually occurred.
    // `sentAt` is set once the provider accepted it, so this also covers a retry
    // that finds the row already SENT (or past it) because the previous run died
    // before appending. The idempotency key keeps it to one event.
    if (
      result.notification.sentAt !== undefined &&
      result.notification.reason === 'trusted_contact_alert'
    ) {
      await appendDomainEvent(pool, {
        eventType: 'TRUSTED_CONTACT_ALERTED',
        aggregateType: 'TrustedContact',
        aggregateId: parsed.disclosure.granteeId,
        tenantId: job.tenantId,
        actorType: 'SYSTEM',
        actorId: 'notifications',
        payload: {
          trusted_contact_id: parsed.disclosure.granteeId,
          notification_id: parsed.notificationId,
          scope: parsed.disclosure.scope,
        },
        idempotencyKey: `trusted-contact-alerted:${parsed.notificationId}`,
      });
    }
  };
}
