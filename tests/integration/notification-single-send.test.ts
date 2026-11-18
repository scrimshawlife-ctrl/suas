/**
 * One provider attempt and one SENT audit per logical send, however many runners race
 * for it (NOTIFICATIONS.md §3, §5; ARCHITECTURE.md §10).
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acceptTrustedContact,
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  grantConsent,
  inviteTrustedContact,
  publishConsentTemplateVersion,
  revokeConsent,
  type DisclosureRequest,
} from '../../src/consent/index.js';
import { createUser } from '../../src/identity/index.js';
import {
  applyDeliveryCallback,
  attemptSend,
  buildNotificationSendPayload,
  enqueueNotification,
  findNotification,
  settleUndeliverable,
  type NotificationChannel,
  type NotificationChannelPort,
} from '../../src/notifications/index.js';
import {
  PRE_CALL_BUDGET_MS,
  PRE_SEND_RETRY_MS,
  SEND_CLAIM_MS,
} from '../../src/notifications/service.js';
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

/** An EMAIL to a trusted contact under a live consent grant, so revoking it denies the send. */
async function grantedEmail() {
  const tenantId = randomUUID();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const invited = await inviteTrustedContact(pool, {
    tenantId,
    veteranUserId: veteran.userId,
    relationshipLabel: 'Battle buddy',
    inviteEmail: syntheticEmail(`contact-${randomUUID().slice(0, 8)}`),
  });
  const contact = await acceptTrustedContact(pool, tenantId, invited.trustedContactId);
  if (contact === undefined) throw new Error('Contact did not accept.');
  const templateKey = `alerts-${randomUUID().slice(0, 8)}`;
  const versionKey = consentTemplateVersionKey(templateKey, 1);
  await createConsentTemplateVersion(pool, { templateKey, version: 1, body: 'Synthetic.' });
  await publishConsentTemplateVersion(pool, versionKey, undefined);
  const disclosure: DisclosureRequest = {
    tenantId,
    veteranUserId: veteran.userId,
    permission: 'can_receive',
    scope: 'RED',
    granteeType: 'TRUSTED_CONTACT',
    granteeId: contact.trustedContactId,
    purpose: 'Alert a trusted contact at red',
  };
  const grant = await grantConsent(pool, {
    ...disclosure,
    consentTemplateVersion: versionKey,
  });
  const { notification } = await enqueueNotification(pool, {
    tenantId,
    recipientUserId: veteran.userId,
    destination: syntheticEmail('recipient'),
    reason: 'trusted_contact_alert',
    channel: 'EMAIL',
    templateVersion: 'alert@1',
    disclosure,
  });
  return {
    tenantId,
    notificationId: notification.notificationId,
    disclosure,
    grantId: grant.consentGrantId,
  };
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

async function claimToken(notificationId: string): Promise<string | null> {
  const result = await pool.query<{ token: string | null }>(
    `SELECT send_claim_token AS token FROM notifications WHERE notification_id = $1`,
    [notificationId],
  );
  return result.rows[0]?.token ?? null;
}

async function untilClaimed(notificationId: string): Promise<void> {
  while ((await claimToken(notificationId)) === null) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Another runner claims the send, as it may once the holder's claim has lapsed. */
async function takeClaim(notificationId: string): Promise<string> {
  const token = randomUUID();
  await pool.query(
    `UPDATE notifications SET send_claim_token = $2, send_claimed_at = now()
     WHERE notification_id = $1`,
    [notificationId, token],
  );
  return token;
}

/** The holder took longer than the claim, so the claim has gone stale. */
async function expireClaim(notificationId: string): Promise<void> {
  await pool.query(
    `UPDATE notifications SET send_claimed_at = now() - interval '1 hour'
     WHERE notification_id = $1`,
    [notificationId],
  );
}

/** Wait until a claim renewal is blocked on a row lock. */
async function untilRenewalWaits(): Promise<void> {
  for (;;) {
    const waiting = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE 'UPDATE notifications SET send_claimed_at = now()%'`,
    );
    if ((waiting.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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

  it('calls the provider once when fifty runners race for one Notification', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(50);
    const input = {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    };
    // More runners than pool connections, so they also queue for the database.
    const results = await Promise.all(
      Array.from({ length: 50 }, () => attemptSend(pool, channels, input)),
    );

    expect(sends).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'SENT')).toHaveLength(1);
    expect(await sentAudits(queued.notificationId)).toBe(1);
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

  it('waits out a claim whose runner never saw it commit, then sends once', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(0);
    const input = {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    };
    // The claim committed but the connection dropped before its answer: no runner holds it.
    await takeClaim(queued.notificationId);

    expect(await attemptSend(pool, channels, input)).toMatchObject({
      outcome: 'SKIPPED',
      reason: 'IN_FLIGHT',
      retryAfterMs: SEND_CLAIM_MS,
    });
    expect(sends).toHaveLength(0);

    await expireClaim(queued.notificationId);
    expect((await attemptSend(pool, channels, input)).outcome).toBe('SENT');
    expect(sends).toHaveLength(1);
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });

  it('sends once when a reopened dead-lettered job and a newly enqueued one both run', async () => {
    const { queued, sends, holder } = await heldSend();
    const jobs = new PostgresOutboxJobQueue(pool);
    const config = loadConfig(validEnv());
    const pass = (owner: string) => runJobWorker({ pool, config, owner, once: true, limit: 10 });
    // Dead-letters on its only attempt (no disclosure to re-check), meets the live claim and
    // is reopened.
    const reopened = await jobs.enqueue({
      jobType: 'notification.send',
      payload: { notification_id: queued.notificationId },
      tenantId: queued.tenantId,
      maxAttempts: 1,
    });
    const reopening = pass('worker-1');
    // A second job for the same send is enqueued meanwhile.
    const fresh = await jobs.enqueue({
      jobType: 'notification.send',
      payload: buildNotificationSendPayload(queued.notificationId, queued.disclosure),
      tenantId: queued.tenantId,
      maxAttempts: 2,
    });
    await reopening;
    const status = async (jobId: string) =>
      (
        await pool.query<{ status: string }>(`SELECT status FROM job_outbox WHERE job_id = $1`, [
          jobId,
        ])
      ).rows[0]?.status;
    expect(await status(reopened.jobId)).toBe('PENDING');

    expect((await holder).outcome).toBe('SENT');
    await pool.query(`UPDATE job_outbox SET run_at = now() WHERE job_id = ANY($1::uuid[])`, [
      [reopened.jobId, fresh.jobId],
    ]);
    await pass('worker-2');

    expect(await status(fresh.jobId)).toBe('SUCCEEDED');
    const after = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(after?.deliveryStatus).toBe('SENT');
    expect(sends).toHaveLength(1);
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });
});

describe('a holder that stalls between its claim and the provider call', () => {
  afterEach(() => vi.useRealTimers());

  /** Hold the users table so the holder's consent re-check waits, as on a slow database. */
  async function stallReCheck(): Promise<PoolClient> {
    const stall = await pool.connect();
    await stall.query('BEGIN');
    await stall.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
    return stall;
  }

  /** Start a send that stalls in its re-check, and return once it holds the claim. */
  async function stalledHolder(
    queued: Awaited<ReturnType<typeof queuedEmail>>,
    channels: Map<NotificationChannel, NotificationChannelPort>,
  ) {
    const stall = await stallReCheck();
    const outcome = attemptSend(pool, channels, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    });
    await untilClaimed(queued.notificationId);
    return { stall, outcome };
  }

  async function release(stall: PoolClient): Promise<void> {
    await stall.query('COMMIT');
    stall.release();
  }

  const deferred = { outcome: 'SKIPPED', retryAfterMs: PRE_SEND_RETRY_MS };

  it('does not call the provider once another runner has taken the expired claim', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(0);
    const { stall, outcome } = await stalledHolder(queued, channels);
    const other = await takeClaim(queued.notificationId);
    await release(stall);

    expect(await outcome).toMatchObject({ ...deferred, reason: 'CLAIM_LOST' });
    expect(sends).toHaveLength(0);
    expect(await claimToken(queued.notificationId)).toBe(other);
  });

  it('does not call the provider for a Notification cancelled while it re-checked consent', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(0);
    const { stall, outcome } = await stalledHolder(queued, channels);
    await pool.query(
      `UPDATE notifications
         SET delivery_status = 'UNDELIVERABLE', cancelled_at = now(), cancel_reason = 'TEST'
       WHERE notification_id = $1`,
      [queued.notificationId],
    );
    await release(stall);

    expect(await outcome).toMatchObject({ ...deferred, reason: 'CLAIM_LOST' });
    expect(sends).toHaveLength(0);
  });

  it('does not send a Notification a dead-lettered job settled while the holder stalled', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(0);
    const { stall, outcome } = await stalledHolder(queued, channels);
    await expireClaim(queued.notificationId);
    const settled = await settleUndeliverable(pool, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      failureReason: 'outbox attempts exhausted',
    });
    expect(settled.outcome).toBe('SETTLED');
    // A settle clears a claim once it has gone stale.
    expect(await claimToken(queued.notificationId)).toBeNull();
    await release(stall);

    expect(await outcome).toMatchObject({ ...deferred, reason: 'CLAIM_LOST' });
    expect(sends).toHaveLength(0);
    const after = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(after?.deliveryStatus).toBe('UNDELIVERABLE');
  });

  it('cancels the send, with no provider call, when consent is revoked after the claim', async () => {
    const granted = await grantedEmail();
    const { sends, channels } = slowCountingEmail(0);
    const { stall, outcome } = await stalledHolder(granted, channels);
    await revokeConsent(stall, granted.tenantId, granted.grantId);
    await release(stall);

    expect(await outcome).toMatchObject({
      outcome: 'CANCELLED',
      reason: 'CONSENT_REVOKED_BEFORE_SEND',
    });
    expect(sends).toHaveLength(0);
  });

  /** The holder's claim renewal answers `elapsedMs` after it was sent, on the holder's clock. */
  async function renewalAnswersAfter(elapsedMs: number) {
    vi.useFakeTimers({ toFake: ['performance'] });
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(0);
    const { stall, outcome } = await stalledHolder(queued, channels);
    // Hold the row so the renewal waits, then move the holder's clock on.
    const row = await pool.connect();
    await row.query('BEGIN');
    await row.query(`SELECT 1 FROM notifications WHERE notification_id = $1 FOR UPDATE`, [
      queued.notificationId,
    ]);
    await release(stall);
    await untilRenewalWaits();
    vi.advanceTimersByTime(elapsedMs);
    await row.query('COMMIT');
    row.release();
    return { queued, sends, result: await outcome };
  }

  it('skips the call and frees the claim when the renewal answers after the pre-call budget', async () => {
    const { queued, sends, result } = await renewalAnswersAfter(PRE_CALL_BUDGET_MS + 1);

    expect(result).toMatchObject({ ...deferred, reason: 'SEND_WINDOW_PASSED' });
    expect(sends).toHaveLength(0);
    expect(await claimToken(queued.notificationId)).toBeNull();
  });

  it('still calls the provider when the renewal answers at exactly the pre-call budget', async () => {
    // Budget + provider allowance + settle margin is exactly the claim, and a claim goes
    // stale only once strictly older than that, so the boundary itself is still safe.
    const { queued, sends, result } = await renewalAnswersAfter(PRE_CALL_BUDGET_MS);

    expect(result.outcome).toBe('SENT');
    expect(sends).toHaveLength(1);
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });

  it('defers a job whose claim is lost before the call, so it never dead-letters and sends once', async () => {
    // A trusted-contact send: its re-check audits the disclosure, which the stall below holds
    // up after the worker's sweeps have run.
    const queued = await grantedEmail();
    const job = await new PostgresOutboxJobQueue(pool).enqueue({
      jobType: 'notification.send',
      payload: buildNotificationSendPayload(queued.notificationId, queued.disclosure),
      tenantId: queued.tenantId,
      maxAttempts: 1,
    });
    const config = loadConfig(validEnv());
    const pass = (owner: string) => runJobWorker({ pool, config, owner, once: true, limit: 10 });
    const jobRow = async () =>
      (
        await pool.query<{ status: string; attempts: number }>(
          `SELECT status, attempts FROM job_outbox WHERE job_id = $1`,
          [job.jobId],
        )
      ).rows[0];

    for (let round = 0; round < 3; round += 1) {
      await pool.query(`UPDATE job_outbox SET run_at = now() WHERE job_id = $1`, [job.jobId]);
      const stall = await pool.connect();
      await stall.query('BEGIN');
      await stall.query('LOCK TABLE audit_events IN SHARE MODE');
      const running = pass(`worker-${round}`);
      await untilClaimed(queued.notificationId);
      await takeClaim(queued.notificationId);
      await release(stall);
      await running;
      expect(await jobRow()).toEqual({ status: 'PENDING', attempts: 0 });
      // The other runner gives the send back without sending.
      await pool.query(
        `UPDATE notifications SET send_claim_token = NULL, send_claimed_at = NULL
         WHERE notification_id = $1`,
        [queued.notificationId],
      );
    }

    await pool.query(`UPDATE job_outbox SET run_at = now() WHERE job_id = $1`, [job.jobId]);
    await pass('worker-final');
    expect((await jobRow())?.status).toBe('SUCCEEDED');
    const sent = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(sent?.deliveryStatus).toBe('SENT');
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });
});

describe('a provider call another writer settles around', () => {
  it('keeps a settlement made during the call, and still audits the attempt once', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(500);
    const holder = attemptSend(pool, channels, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    });
    while (sends.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    await expireClaim(queued.notificationId);
    const settled = await settleUndeliverable(pool, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      failureReason: 'outbox attempts exhausted',
    });
    expect(settled.outcome).toBe('SETTLED');

    expect(await holder).toMatchObject({ outcome: 'SKIPPED', reason: 'CLAIM_LOST' });
    const after = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(after).toMatchObject({ deliveryStatus: 'UNDELIVERABLE', attemptCount: 1 });
    expect(await sentAudits(queued.notificationId)).toBe(1);
  });

  it('keeps a delivery callback that lands mid-send, and audits the attempt once', async () => {
    const queued = await queuedEmail();
    const { sends, channels } = slowCountingEmail(500);
    const holder = attemptSend(pool, channels, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      disclosure: queued.disclosure,
    });
    while (sends.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    const callback = await applyDeliveryCallback(pool, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      providerEventId: `evt-${randomUUID()}`,
      reportedStatus: 'DELIVERED',
    });
    expect(callback.applied).toBe(true);
    // The callback leaves the live claim to its holder.
    expect(await claimToken(queued.notificationId)).not.toBeNull();

    expect(await holder).toMatchObject({ outcome: 'SKIPPED', reason: 'CLAIM_LOST' });
    const after = await findNotification(pool, queued.tenantId, queued.notificationId);
    expect(after).toMatchObject({ deliveryStatus: 'DELIVERED', attemptCount: 1 });
    expect(after?.sentAt).toBeDefined();
    expect(await sentAudits(queued.notificationId)).toBe(1);
    expect(await claimToken(queued.notificationId)).toBeNull();
  });
});

describe('settling an exhausted send UNDELIVERABLE', () => {
  it('audits the failure reason on one line and cut to 300 characters', async () => {
    const queued = await queuedEmail();
    const reason = `relay said:\n\u0000\u001b[31mrefused\r\t${'x'.repeat(5_000)}`;

    const settled = await settleUndeliverable(pool, {
      tenantId: queued.tenantId,
      notificationId: queued.notificationId,
      failureReason: reason,
    });
    expect(settled.outcome).toBe('SETTLED');

    const audit = await pool.query<{ payload: { failure_reason: string } }>(
      `SELECT payload FROM audit_events
        WHERE aggregate_id = $1 AND event_type = 'NOTIFICATION_UNDELIVERABLE'`,
      [queued.notificationId],
    );
    const recorded = audit.rows.map((row) => row.payload.failure_reason);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toHaveLength(300);
    expect(recorded[0]?.startsWith('relay said:   [31mrefused  xxx')).toBe(true);
  });
});
