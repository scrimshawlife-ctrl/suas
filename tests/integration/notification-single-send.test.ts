/**
 * One provider attempt and one SENT audit per logical send, however many runners race
 * for it (NOTIFICATIONS.md §3, §5; ARCHITECTURE.md §10).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { DisclosureRequest } from '../../src/consent/index.js';
import { createUser } from '../../src/identity/index.js';
import {
  attemptSend,
  buildNotificationSendPayload,
  enqueueNotification,
  findNotification,
  settleUndeliverable,
  type NotificationChannel,
  type NotificationChannelPort,
} from '../../src/notifications/index.js';
import {
  claimDueJobs,
  DispatchingJobQueue,
  PostgresOutboxJobQueue,
  runJobUnderLease,
  type DurableJobQueuePort,
} from '../../src/jobs/index.js';
import { notificationSendHandler } from '../../src/jobs/handlers.js';
import { runJobWorker } from '../../src/jobs/worker.js';
import { loadConfig } from '../../src/config/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { validEnv } from '../helpers/env.js';

const pool: Pool = createTestPool(10);

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

/** An EMAIL port that counts provider calls and takes `delayMs` to accept, like a slow provider. */
function slowCountingEmail(delayMs: number) {
  const sends: string[] = [];
  const port: NotificationChannelPort = {
    channel: 'EMAIL',
    mode: 'fake',
    implementation: 'test-counting',
    async send(message) {
      sends.push(message.idempotencyKey);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return { accepted: true, providerReference: `test-${message.idempotencyKey}` };
    },
  };
  return {
    sends,
    channels: new Map<NotificationChannel, NotificationChannelPort>([['EMAIL', port]]),
  };
}

async function queuedEmail(jobQueue?: DurableJobQueuePort) {
  const tenantId = randomUUID();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const disclosure: DisclosureRequest = {
    tenantId,
    veteranUserId: veteran.userId,
    permission: 'can_view',
    scope: 'current_requests',
    granteeType: 'SYSTEM',
    granteeId: 'notifications',
    purpose: 'single-send regression',
    systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
  };
  const { notification } = await enqueueNotification(
    pool,
    {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_invited',
      channel: 'EMAIL',
      templateVersion: 'invite@1',
      disclosure,
    },
    jobQueue !== undefined ? { jobQueue } : {},
  );
  return { tenantId, notificationId: notification.notificationId, disclosure };
}

async function sentAudits(notificationId: string): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events
      WHERE aggregate_id = $1 AND event_type = 'NOTIFICATION_SEND_ATTEMPTED'
        AND payload->>'outcome' = 'SENT'`,
    [notificationId],
  );
  return result.rows[0]?.n ?? 0;
}

describe('attemptSend under concurrent runners', () => {
  it('calls the provider once and records one SENT when two runners send the same Notification', async () => {
    for (let round = 0; round < 5; round += 1) {
      const queued = await queuedEmail();
      const { sends, channels } = slowCountingEmail(50);
      const input = {
        tenantId: queued.tenantId,
        notificationId: queued.notificationId,
        disclosure: queued.disclosure,
      };
      await Promise.all([attemptSend(pool, channels, input), attemptSend(pool, channels, input)]);

      expect(sends).toHaveLength(1);
      expect(await sentAudits(queued.notificationId)).toBe(1);
    }
  });

  it('lets a later runner see the in-flight send instead of sending again', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(300);
    const input = {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    };
    const first = attemptSend(pool, channels, input);
    // The second runner starts while the first is waiting on the provider.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await attemptSend(pool, channels, input);
    await first;

    expect(second.outcome).toBe('SKIPPED');
    expect(sends).toHaveLength(1);
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });
});

/** An EMAIL port that refuses every send, retryably, so the Notification is left FAILED. */
const refusingEmail = new Map<NotificationChannel, NotificationChannelPort>([
  [
    'EMAIL',
    {
      channel: 'EMAIL',
      mode: 'fake',
      implementation: 'test-refusing',
      send: () => Promise.resolve({ accepted: false, failureReason: 'test refusal' }),
    },
  ],
]);

async function lastAttemptAt(notificationId: string): Promise<string | null> {
  const result = await pool.query<{ at: string | null }>(
    `SELECT last_attempt_at::text AS at FROM notifications WHERE notification_id = $1`,
    [notificationId],
  );
  return result.rows[0]?.at ?? null;
}

describe('the send claim leaves the visible delivery record alone', () => {
  it('keeps a retry FAILED, with its last attempt time, while the retry is in flight', async () => {
    const queued = await queuedEmail();
    const input = {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    };
    await attemptSend(pool, refusingEmail, input);
    const failedAt = await lastAttemptAt(queued.notificationId);

    const retry = attemptSend(pool, slowCountingEmail(300).channels, input);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const during = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(during?.deliveryStatus).toBe('FAILED');
    expect(await lastAttemptAt(queued.notificationId)).toBe(failedAt);

    expect((await retry).outcome).toBe('SENT');
  });

  it('records no attempt time for a send cancelled before any provider call', async () => {
    const queued = await queuedEmail();
    // No grant backs this disclosure, so the re-check before the attempt denies it.
    const { systemBasis: _unused, ...withoutBasis } = queued.disclosure;
    const denied: DisclosureRequest = {
      ...withoutBasis,
      granteeType: 'TRUSTED_CONTACT',
      granteeId: randomUUID(),
    };
    const result = await attemptSend(pool, slowCountingEmail(0).channels, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: denied,
    });

    expect(result.outcome).toBe('CANCELLED');
    expect(await lastAttemptAt(queued.notificationId)).toBeNull();
  });
});

describe('inline notification.send and a job worker pass', () => {
  it('leases the job while the API sends inline, so a worker pass skips it', async () => {
    const { sends, channels } = slowCountingEmail(300);
    const send = notificationSendHandler(pool, channels);
    // Wired as src/app.ts wires the API's queue over the outbox.
    const api = new DispatchingJobQueue(
      new PostgresOutboxJobQueue(pool),
      { 'notification.send': send },
      () => undefined,
      (job, run) => runJobUnderLease(pool, { jobId: job.jobId, owner: 'api-inline' }, run),
    );
    const enqueueing = queuedEmail(api);
    // A scheduled worker pass lands while the API is still waiting on the provider.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const claimed = await claimDueJobs(pool, { owner: 'worker', jobType: 'notification.send' });
    await Promise.all(claimed.map((job) => send(job)));
    const { notificationId } = await enqueueing;

    expect(claimed).toHaveLength(0);
    expect(sends).toHaveLength(1);
    expect(await sentAudits(notificationId)).toBe(1);
    const job = await pool.query<{ status: string }>(
      `SELECT status FROM job_outbox WHERE idempotency_key = $1`,
      [notificationId],
    );
    expect(job.rows[0]?.status).toBe('SUCCEEDED');
  });
});

describe('a send another runner holds', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function heldSend() {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(1_500);
    const holder = attemptSend(pool, channels, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    });
    await sleep(100);
    return { queued, sends, holder };
  }

  it('makes a duplicate job wait without spending its attempts, and the holder SENT stands', async () => {
    const { queued, sends, holder } = await heldSend();
    // A second job for the same send, with two attempts to spend.
    const duplicate = await new PostgresOutboxJobQueue(pool).enqueue({
      jobType: 'notification.send',
      payload: buildNotificationSendPayload(queued.notificationId, queued.disclosure),
      tenantId: queued.tenantId,
      maxAttempts: 2,
    });
    const config = loadConfig(validEnv());
    for (let pass = 0; pass < 3; pass += 1) {
      await pool.query(`UPDATE job_outbox SET run_at = now() WHERE job_id = $1`, [duplicate.jobId]);
      await runJobWorker({ pool, config, owner: `worker-${pass}`, once: true, limit: 10 });
    }

    const job = await pool.query<{ status: string; attempts: number }>(
      `SELECT status, attempts FROM job_outbox WHERE job_id = $1`,
      [duplicate.jobId],
    );
    expect(job.rows[0]).toEqual({ status: 'PENDING', attempts: 0 });
    await holder;
    const sent = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(sent?.deliveryStatus).toBe('SENT');
    expect(sends).toHaveLength(1);
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });

  it('is not settled UNDELIVERABLE by a dead-lettered job while the claim is live', async () => {
    const { queued, holder } = await heldSend();

    const settled = await settleUndeliverable(pool, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      failureReason: 'outbox attempts exhausted',
    });
    expect(settled.outcome).toBe('IN_FLIGHT');

    expect((await holder).outcome).toBe('SENT');
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });

  it('re-runs a dead-lettered job after a crashed holder claim expires, so the send settles', async () => {
    const queued = await queuedEmail();
    const hanging = new Map<NotificationChannel, NotificationChannelPort>([
      [
        'EMAIL',
        {
          channel: 'EMAIL',
          mode: 'fake',
          implementation: 'test-hanging',
          send: () => new Promise(() => undefined),
        },
      ],
    ]);
    // The holder crashes mid-send: its provider call never returns and it never settles.
    void attemptSend(pool, hanging, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    });
    await sleep(100);
    // A job that dead-letters on its only attempt (no disclosure to re-check) meets the claim.
    const job = await new PostgresOutboxJobQueue(pool).enqueue({
      jobType: 'notification.send',
      payload: { notification_id: queued.notificationId },
      tenantId: queued.tenantId,
      maxAttempts: 1,
    });
    const config = loadConfig(validEnv());
    const jobStatus = async () =>
      (
        await pool.query<{ status: string }>(`SELECT status FROM job_outbox WHERE job_id = $1`, [
          job.jobId,
        ])
      ).rows[0]?.status;
    const deliveryStatus = async () =>
      (await findNotification(pool, queued.tenantId, queued.notificationId))?.deliveryStatus;

    await runJobWorker({ pool, config, owner: 'worker-1', once: true, limit: 10 });
    expect(await jobStatus()).toBe('PENDING');
    expect(await deliveryStatus()).toBe('QUEUED');

    // Time passes: the crashed holder's claim expires and the job comes due.
    await pool.query(
      `UPDATE notifications SET send_claimed_at = now() - interval '1 hour'
       WHERE notification_id = $1`,
      [queued.notificationId],
    );
    await pool.query(`UPDATE job_outbox SET run_at = now() WHERE job_id = $1`, [job.jobId]);
    await runJobWorker({ pool, config, owner: 'worker-2', once: true, limit: 10 });

    expect(await deliveryStatus()).toBe('UNDELIVERABLE');
    const audits = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
        WHERE aggregate_id = $1 AND event_type = 'NOTIFICATION_UNDELIVERABLE'`,
      [queued.notificationId],
    );
    expect(audits.rows[0]?.n).toBe(1);
  });
});
