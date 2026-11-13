/**
 * `job-worker --once` drains the outbox, including `notification.send`
 * (NOTIFICATIONS.md §5; AGENTS.md rules 9-10: a replayed job must not send twice).
 *
 * Runs the real CLI against the test database, so the wiring the deploy uses is
 * what is under test.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  acceptTrustedContact,
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  grantConsent,
  inviteTrustedContact,
  publishConsentTemplateVersion,
  type DisclosureRequest,
} from '../../src/consent/index.js';
import { openCase } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { createUser } from '../../src/identity/index.js';
import { PostgresOutboxJobQueue } from '../../src/jobs/index.js';
import { createFollowUp } from '../../src/settlement/index.js';
import { ensurePublishedQv001, startCheckIn } from '../../src/signals/index.js';
import { enqueueNotification } from '../../src/notifications/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { testDatabaseUrl } from '../helpers/env.js';

const run = promisify(execFile);
const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function drainOnce(env: Record<string, string> = {}): Promise<void> {
  await run(
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli/job-worker.ts', '--once', '--limit', '50'],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: {
        ...process.env,
        DATABASE_URL: testDatabaseUrl(),
        SUAS_MIGRATIONS_MODE: 'validate',
        ...env,
      },
    },
  );
}

function newUser(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

/** A Veteran whose accepted Trusted Contact holds an active RED-alert grant. */
async function alertGrant() {
  const tenantId = syntheticTenantId();
  const veteran = await newUser(tenantId, 'veteran');
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
  const purpose = 'Alert a trusted contact at red';
  const grant = await grantConsent(pool, {
    tenantId,
    veteranUserId: veteran.userId,
    permission: 'can_receive',
    scope: 'RED',
    purpose,
    granteeType: 'TRUSTED_CONTACT',
    granteeId: contact.trustedContactId,
    consentTemplateVersion: versionKey,
  });
  const disclosure: DisclosureRequest = {
    tenantId,
    veteranUserId: veteran.userId,
    permission: 'can_receive',
    scope: 'RED',
    granteeType: 'TRUSTED_CONTACT',
    granteeId: contact.trustedContactId,
    purpose,
  };
  return { tenantId, veteran, disclosure, grantId: grant.consentGrantId };
}

/** An EMAIL send with its outbox job, as a RED alert enqueues it. */
async function queuedNotification() {
  const { tenantId, veteran, disclosure } = await alertGrant();
  const { notification } = await enqueueNotification(
    pool,
    {
      tenantId,
      recipientUserId: veteran.userId,
      destination: syntheticEmail('recipient'),
      reason: 'trusted_contact_alert',
      channel: 'EMAIL',
      templateVersion: 'alert@1',
      disclosure,
    },
    { jobQueue: new PostgresOutboxJobQueue(pool) },
  );
  return { tenantId, notificationId: notification.notificationId };
}

async function sendState(notificationId: string) {
  const row = await pool.query<{ delivery_status: string; attempt_count: number }>(
    'SELECT delivery_status, attempt_count FROM notifications WHERE notification_id = $1',
    [notificationId],
  );
  const audits = await pool.query(
    `SELECT 1 FROM audit_events
     WHERE event_type = 'NOTIFICATION_SEND_ATTEMPTED' AND target_id = $1`,
    [notificationId],
  );
  const job = await pool.query<{ status: string }>(
    `SELECT status FROM job_outbox WHERE job_type = 'notification.send'`,
  );
  return {
    status: row.rows[0]?.delivery_status,
    attempts: row.rows[0]?.attempt_count,
    auditEvents: audits.rowCount,
    jobStatus: job.rows[0]?.status,
  };
}

describe('job-worker --once and notification.send', () => {
  it('sends a queued Notification and marks its job done', async () => {
    const { notificationId } = await queuedNotification();
    await drainOnce();
    expect(await sendState(notificationId)).toEqual({
      status: 'SENT',
      attempts: 1,
      auditEvents: 1,
      jobStatus: 'SUCCEEDED',
    });
  });

  it('does not send again when the same job is delivered again', async () => {
    const { notificationId } = await queuedNotification();
    await drainOnce();
    await pool.query(
      `UPDATE job_outbox SET status = 'PENDING', leased_until = NULL, lease_owner = NULL
       WHERE job_type = 'notification.send'`,
    );
    await drainOnce();
    expect(await sendState(notificationId)).toEqual({
      status: 'SENT',
      attempts: 1,
      auditEvents: 1,
      jobStatus: 'SUCCEEDED',
    });
  });

  it('fails closed on a job without the disclosure to re-check, and settles it (C-06)', async () => {
    const { notificationId } = await queuedNotification();
    await pool.query(
      `UPDATE job_outbox SET payload = $1::jsonb, max_attempts = 1
       WHERE job_type = 'notification.send'`,
      [JSON.stringify({ notification_id: notificationId })],
    );
    await drainOnce();
    // Nothing was sent; the exhausted send is visible instead of left QUEUED.
    expect(await sendState(notificationId)).toMatchObject({
      status: 'UNDELIVERABLE',
      attempts: 0,
      auditEvents: 0,
      jobStatus: 'DEAD_LETTER',
    });
  });

  it('settles UNDELIVERABLE with an audit when the channel is unavailable on every try (C-06)', async () => {
    const { notificationId } = await queuedNotification();
    await pool.query(`UPDATE job_outbox SET max_attempts = 1 WHERE job_type = 'notification.send'`);
    await drainOnce({ SUAS_EMAIL_MODE: 'disabled' });

    expect(await sendState(notificationId)).toMatchObject({
      status: 'UNDELIVERABLE',
      attempts: 0,
      auditEvents: 0,
      jobStatus: 'DEAD_LETTER',
    });
    const settled = await pool.query<{ payload: { failure_reason: string } }>(
      `SELECT payload FROM audit_events
       WHERE event_type = 'NOTIFICATION_UNDELIVERABLE' AND target_id = $1`,
      [notificationId],
    );
    expect(settled.rows).toHaveLength(1);
    expect(settled.rows[0]?.payload.failure_reason).toContain('no configured delivery path');
  });
});

describe('job-worker --once time-driven sweeps', () => {
  it('marks a due Follow-Up DUE with one FOLLOWUP_DUE event (A2-03, FOLLOWUP.md §5)', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await newUser(tenantId, 'veteran');
    const responder = await newUser(tenantId, 'responder');
    const opened = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'USER',
        actorId: responder.userId,
      }),
    );
    const followUp = await createFollowUp(pool, {
      tenantId,
      caseId: opened.supportCase.caseId,
      dueAt: new Date(Date.now() - 60_000),
      responsibleType: 'USER',
      responsibleId: responder.userId,
      actorId: responder.userId,
      actorType: 'USER',
    });

    await drainOnce();
    await drainOnce();

    const row = await pool.query<{ status: string }>(
      'SELECT status FROM follow_ups WHERE follow_up_id = $1',
      [followUp.followUpId],
    );
    expect(row.rows[0]?.status).toBe('DUE');
    const events = await pool.query(
      `SELECT 1 FROM domain_events WHERE event_type = 'FOLLOWUP_DUE' AND aggregate_id = $1`,
      [followUp.followUpId],
    );
    expect(events.rowCount).toBe(1);
  });

  it('expires a lapsed consent grant with an EXPIRED ConsentEvent (A1-09, CONSENT.md §7-§8)', async () => {
    const { grantId } = await alertGrant();
    await pool.query(
      `UPDATE consent_grants SET expires_at = now() - interval '1 minute'
       WHERE consent_grant_id = $1`,
      [grantId],
    );

    await drainOnce();

    const grant = await pool.query<{ status: string }>(
      'SELECT status FROM consent_grants WHERE consent_grant_id = $1',
      [grantId],
    );
    expect(grant.rows[0]?.status).toBe('EXPIRED');
    const events = await pool.query(
      `SELECT 1 FROM consent_events WHERE consent_grant_id = $1 AND event_type = 'EXPIRED'`,
      [grantId],
    );
    expect(events.rowCount).toBe(1);
  });

  it('prunes elapsed rate-limit windows and keeps the current one (A1-15)', async () => {
    const subject = `prune-${randomUUID()}`;
    await pool.query(
      `INSERT INTO auth_rate_limits (bucket, subject, window_start, count)
       VALUES ('auth.challenge.issue', $1, now() - interval '2 hours', 3),
              ('auth.challenge.issue', $1, now(), 1)`,
      [subject],
    );

    await drainOnce();

    const left = await pool.query<{ count: number }>(
      'SELECT count FROM auth_rate_limits WHERE subject = $1',
      [subject],
    );
    expect(left.rows).toEqual([{ count: 1 }]);
  });
});

describe('job-worker --once and the Check-In idle sweep', () => {
  it('abandons a Check-In older than 24 hours and keeps the row', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await ensurePublishedQv001(pool, veteran.userId);
    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    await pool.query(
      `UPDATE check_ins SET started_at = now() - interval '25 hours' WHERE check_in_id = $1`,
      [checkIn.checkInId],
    );

    await drainOnce();

    const row = await pool.query<{ status: string }>(
      'SELECT status FROM check_ins WHERE check_in_id = $1',
      [checkIn.checkInId],
    );
    expect(row.rows[0]?.status).toBe('ABANDONED');
  });

  it('re-enqueues the signal job of a completed Check-In that lost it (A2-02, CHECKINS.md §6)', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await ensurePublishedQv001(pool, veteran.userId);
    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    // Committed as COMPLETED, but the enqueue after the commit never happened.
    await pool.query(
      `UPDATE check_ins SET status = 'COMPLETED', completed_at = now() - interval '10 minutes'
       WHERE check_in_id = $1`,
      [checkIn.checkInId],
    );

    await drainOnce();

    const jobs = await pool.query(
      `SELECT 1 FROM job_outbox WHERE job_type = 'support-signal.compute' AND idempotency_key = $1`,
      [`support-signal:${checkIn.checkInId}`],
    );
    expect(jobs.rowCount).toBe(1);
  });
});
