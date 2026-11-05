/**
 * RED alert to Trusted Contacts (requires PostgreSQL).
 *
 * SUAS-specs SAFETY.md §3.3-§3.4; TRUSTED_CIRCLE.md §6, §11; NOTIFICATIONS.md §3-§4.
 * Drives the real path: Check-In → compute job → settle → outbox → send handler.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  acceptTrustedContact,
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  grantConsent,
  inviteTrustedContact,
  publishConsentTemplateVersion,
  setTrustedContactStatus,
  type ConsentScope,
} from '../../src/consent/index.js';
import { createUser } from '../../src/identity/index.js';
import {
  DispatchingJobQueue,
  InMemoryJobQueue,
  type DurableJobQueuePort,
} from '../../src/jobs/index.js';
import { notificationSendHandler } from '../../src/jobs/handlers.js';
import { createChannelRegistry, type RecordingChannel } from '../../src/notifications/index.js';
import {
  completeCheckIn,
  ensurePublishedQv001,
  listQuestions,
  QV_001_VERSION,
  runSupportSignalComputeJob,
  saveResponse,
  startCheckIn,
} from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { validEnv } from '../helpers/env.js';

const pool: Pool = createTestPool();
const config = loadConfig(validEnv());

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

const GREEN: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};
const RED: Readonly<Record<string, string>> = { ...GREEN, safe_now: 'NO_IMMEDIATE_HELP' };

async function answerAndComplete(
  tenantId: string,
  veteranUserId: string,
  checkInId: string,
  answers: Readonly<Record<string, string>>,
): Promise<void> {
  const questions = await listQuestions(pool, QV_001_VERSION);
  const options = await pool.query<{
    question_id: string;
    option_key: string;
    answer_option_id: string;
  }>(
    `SELECT q.question_id, o.option_key, o.answer_option_id
     FROM questions q JOIN answer_options o ON o.question_id = q.question_id
     WHERE q.questionnaire_version = $1`,
    [QV_001_VERSION],
  );
  for (const question of questions) {
    const optionKey = answers[question.questionKey];
    const option = options.rows.find(
      (row) => row.question_id === question.questionId && row.option_key === optionKey,
    );
    if (option === undefined) continue;
    await saveResponse(pool, {
      tenantId,
      checkInId,
      questionId: question.questionId,
      answerOptionId: option.answer_option_id,
    });
  }
  await completeCheckIn(pool, { tenantId, checkInId, actorId: veteranUserId });
}

async function setup() {
  const tenantId = syntheticTenantId();
  const mk = (label: string) =>
    createUser(pool, {
      tenantId,
      email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
  const veteran = await mk('vet');
  const admin = await mk('admin');
  const helper = await mk('helper');
  await ensurePublishedQv001(pool, admin.userId);

  const templateKey = `red-${randomUUID().slice(0, 8)}`;
  const versionKey = consentTemplateVersionKey(templateKey, 1);
  await createConsentTemplateVersion(pool, { templateKey, version: 1, body: 'Synthetic.' });
  await publishConsentTemplateVersion(pool, versionKey, undefined);

  /** A contact with the given membership state and optional grant scope. */
  async function contact(
    label: string,
    options: { accept: boolean; scope?: ConsentScope; status?: 'SUSPENDED' },
  ) {
    const email = syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`);
    const invited = await inviteTrustedContact(pool, {
      tenantId,
      veteranUserId: veteran.userId,
      relationshipLabel: label,
      inviteEmail: email,
    });
    if (options.accept) await acceptTrustedContact(pool, tenantId, invited.trustedContactId);
    if (options.status !== undefined) {
      await setTrustedContactStatus(pool, tenantId, invited.trustedContactId, options.status);
    }
    if (options.scope !== undefined) {
      await grantConsent(pool, {
        tenantId,
        veteranUserId: veteran.userId,
        permission: 'can_receive',
        scope: options.scope,
        purpose: 'Alert a trusted contact at red',
        granteeType: 'TRUSTED_CONTACT',
        granteeId: invited.trustedContactId,
        consentTemplateVersion: versionKey,
      });
    }
    return { email, id: invited.trustedContactId };
  }

  const channels = createChannelRegistry(config);
  const email = channels.get('EMAIL') as RecordingChannel;
  // Surface handler failures instead of letting the dispatcher swallow them.
  const failures: unknown[] = [];
  const dispatching = new DispatchingJobQueue(
    new InMemoryJobQueue(),
    {
      'notification.send': async (request) => {
        try {
          await notificationSendHandler(pool, channels)(request);
        } catch (error) {
          failures.push(error);
        }
      },
    },
    (error) => failures.push(error),
  );

  async function checkIn(answers: Readonly<Record<string, string>>) {
    const started = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    await answerAndComplete(tenantId, veteran.userId, started.checkInId, answers);
    return started.checkInId;
  }
  const compute = (checkInId: string, jobQueue: DurableJobQueuePort = dispatching) =>
    runSupportSignalComputeJob(pool, config, { tenantId, checkInId }, { jobQueue });
  const sendHandler = notificationSendHandler(pool, channels);
  const notifications = () =>
    pool.query<{ destination: string; recipient_user_id: string | null; reason: string }>(
      `SELECT destination, recipient_user_id, reason FROM notifications WHERE tenant_id = $1`,
      [tenantId],
    );
  const alertedEvents = async () =>
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM domain_events
           WHERE tenant_id = $1 AND event_type = 'TRUSTED_CONTACT_ALERTED'`,
          [tenantId],
        )
      ).rows[0]?.n,
    );

  return {
    sendHandler,
    dispatching,
    tenantId,
    veteran,
    helper,
    contact,
    email,
    checkIn,
    compute,
    notifications,
    alertedEvents,
    failures,
  };
}

describe('F9 RED alert to Trusted Contacts', () => {
  it('alerts only accepted, active contacts holding a RED grant, and nobody else', async () => {
    const s = await setup();
    const consented = await s.contact('consented', { accept: true, scope: 'RED' });
    await s.contact('no-grant', { accept: true });
    await s.contact('orange-only', { accept: true, scope: 'ORANGE' });
    await s.contact('not-accepted', { accept: false, scope: 'RED' });
    await s.contact('suspended', { accept: true, scope: 'RED', status: 'SUSPENDED' });

    const result = await s.compute(await s.checkIn(RED));

    expect(result.signal?.level).toBe('RED');
    expect(s.failures).toEqual([]);
    expect(s.email.sent().map((m) => m.destination)).toEqual([consented.email]);
    expect(s.email.sent()[0]?.templateVersion).toBe('alert@1');
    const rows = (await s.notifications()).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      destination: consented.email,
      reason: 'trusted_contact_alert',
    });
    // Neither the veteran's helper account nor anyone else was messaged.
    expect(rows.some((row) => row.recipient_user_id === s.helper.userId)).toBe(false);
    expect(await s.alertedEvents()).toBe(1);
  });

  it('sends one alert per contact even when the compute job is replayed', async () => {
    const s = await setup();
    await s.contact('a', { accept: true, scope: 'RED' });
    await s.contact('b', { accept: true, scope: 'RED' });
    const checkInId = await s.checkIn(RED);

    await s.compute(checkInId);
    await s.compute(checkInId);
    await s.compute(checkInId);

    expect(s.failures).toEqual([]);
    expect(s.email.sent()).toHaveLength(2);
    expect((await s.notifications()).rows).toHaveLength(2);
    expect(await s.alertedEvents()).toBe(2);
  });

  it('sends nothing for a non-RED signal, even to a contact with a RED grant', async () => {
    const s = await setup();
    await s.contact('consented', { accept: true, scope: 'RED' });

    const result = await s.compute(await s.checkIn(GREEN));

    expect(result.signal?.level).toBe('GREEN');
    expect(s.email.sent()).toHaveLength(0);
    expect((await s.notifications()).rows).toHaveLength(0);
  });

  it('settles RED and sends nothing when the veteran has no eligible contact', async () => {
    const s = await setup();

    const result = await s.compute(await s.checkIn(RED));

    expect(result.status).toBe('SETTLED');
    expect(result.signal?.level).toBe('RED');
    expect(s.email.sent()).toHaveLength(0);
    expect((await s.notifications()).rows).toHaveLength(0);
    expect(await s.alertedEvents()).toBe(0);
  });

  it('recovers when the process dies after the Notification row but before its send job', async () => {
    const s = await setup();
    const consented = await s.contact('consented', { accept: true, scope: 'RED' });
    const checkInId = await s.checkIn(RED);

    // First attempt: the row is inserted, then enqueueing the send job fails.
    const crashing: DurableJobQueuePort = {
      durability: s.dispatching.durability,
      implementation: s.dispatching.implementation,
      enqueue: () => Promise.reject(new Error('process died before enqueue')),
    };
    await expect(s.compute(checkInId, crashing)).rejects.toThrow('process died');
    expect((await s.notifications()).rows).toHaveLength(1);
    expect(s.email.sent()).toHaveLength(0);

    // Retry: the dedupe hit must re-enqueue the missing send, not skip it.
    await s.compute(checkInId);
    await s.compute(checkInId);

    expect(s.failures).toEqual([]);
    expect(s.email.sent().map((m) => m.destination)).toEqual([consented.email]);
    expect((await s.notifications()).rows).toHaveLength(1);
  });

  it('writes the missing TRUSTED_CONTACT_ALERTED event when the row was already SENT', async () => {
    const s = await setup();
    await s.contact('consented', { accept: true, scope: 'RED' });
    const held = new InMemoryJobQueue();
    await s.compute(await s.checkIn(RED), held);
    const job = held.enqueued()[0];
    if (job === undefined) throw new Error('no send job was enqueued');

    // Simulate a crash after the provider accepted and the row was marked SENT,
    // but before the audit event was appended.
    await pool.query(
      `UPDATE notifications SET delivery_status = 'SENT', sent_at = now() WHERE tenant_id = $1`,
      [s.tenantId],
    );
    expect(await s.alertedEvents()).toBe(0);

    await s.sendHandler(job);
    await s.sendHandler(job);

    expect(await s.alertedEvents()).toBe(1);
    // The already-sent row is not sent again.
    expect(s.email.sent()).toHaveLength(0);
  });
});
