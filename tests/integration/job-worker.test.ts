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
import { createUser } from '../../src/identity/index.js';
import { PostgresOutboxJobQueue } from '../../src/jobs/index.js';
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

async function drainOnce(): Promise<void> {
  await run(
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli/job-worker.ts', '--once', '--limit', '50'],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl(), SUAS_MIGRATIONS_MODE: 'validate' },
    },
  );
}

async function queuedNotification() {
  const tenantId = syntheticTenantId();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const { notification } = await enqueueNotification(
    pool,
    {
      tenantId,
      recipientUserId: veteran.userId,
      reason: 'qrf.responder_notified',
      channel: 'IN_APP',
      templateVersion: 'test@1',
      disclosure: {
        tenantId,
        veteranUserId: veteran.userId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'SYSTEM',
        granteeId: 'notifications',
        purpose: 'Notify the veteran about their own request',
        systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
      },
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

  it('fails closed on a job without the disclosure to re-check', async () => {
    const { notificationId } = await queuedNotification();
    await pool.query(
      `UPDATE job_outbox SET payload = $1::jsonb, max_attempts = 1
       WHERE job_type = 'notification.send'`,
      [JSON.stringify({ notification_id: notificationId })],
    );
    await drainOnce();
    expect(await sendState(notificationId)).toMatchObject({
      status: 'QUEUED',
      attempts: 0,
      auditEvents: 0,
      jobStatus: 'DEAD_LETTER',
    });
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
});
