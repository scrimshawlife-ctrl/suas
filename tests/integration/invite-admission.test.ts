import { createUser } from '../../src/identity/index.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumeRateLimit } from '../../src/auth/rate-limit.js';
import { INVITE_EMAIL_CAP_PER_RECIPIENT } from '../../src/consent/invite-limits.js';
import {
  enqueueNotification,
  type EnqueueNotificationInput,
} from '../../src/notifications/index.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';

const pool = createTestPool(8);
beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function input(): Promise<EnqueueNotificationInput> {
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: `audit-${randomUUID()}@example.invalid`,
    status: 'ACTIVE',
  });
  return {
    tenantId,
    destination: 'audit@example.invalid',
    channel: 'EMAIL',
    reason: 'trusted_contact_invited',
    templateVersion: 'invite@1',
    dedupeKey: randomUUID(),
    disclosure: {
      tenantId,
      veteranUserId: user.userId,
      permission: 'can_view',
      scope: 'current_requests',
      granteeType: 'SYSTEM',
      granteeId: 'notifications',
      purpose: 'Synthetic invitation',
      systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
    },
    recipientLimit: {
      policy: INVITE_EMAIL_CAP_PER_RECIPIENT,
      subject: `${tenantId}:audit@example.invalid`,
      failureReason: 'INVITE_RECIPIENT_CAP',
    },
  };
}

describe('notification recipient admission commits with the intent', () => {
  it('does not expose a sendable row while admission is blocked, including to a concurrent replay', async () => {
    const request = await input();
    const subject = request.recipientLimit!.subject;
    for (let n = 0; n < INVITE_EMAIL_CAP_PER_RECIPIENT.limit; n++) {
      await consumeRateLimit(pool, INVITE_EMAIL_CAP_PER_RECIPIENT, subject);
    }
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT 1 FROM auth_rate_limits WHERE subject = $1 FOR UPDATE', [subject]);
    const first = enqueueNotification(pool, request);
    void first.catch(() => undefined);
    let replay: ReturnType<typeof enqueueNotification> | undefined;
    try {
      await vi.waitFor(async () => {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%WITH window_bounds AS%'",
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
      expect(
        (await pool.query('SELECT 1 FROM notifications WHERE tenant_id = $1', [request.tenantId]))
          .rowCount,
      ).toBe(0);
      replay = enqueueNotification(pool, request);
      void replay.catch(() => undefined);
      await vi.waitFor(async () => {
        const waiting = await pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%INSERT INTO notifications%'",
        );
        expect(waiting.rowCount).toBeGreaterThan(0);
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled([first, ...(replay ? [replay] : [])]);
    }
    const outcomes = await Promise.all([first, replay]);
    expect(outcomes.map((x) => x.notification.deliveryStatus)).toEqual([
      'UNDELIVERABLE',
      'UNDELIVERABLE',
    ]);
    expect(outcomes[1].deduplicated).toBe(true);
    expect(
      (await pool.query('SELECT count FROM auth_rate_limits WHERE subject = $1', [subject])).rows[0]
        ?.count,
    ).toBe(6);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM audit_events WHERE tenant_id = $1 AND event_type = 'NOTIFICATION_UNDELIVERABLE'",
          [request.tenantId],
        )
      ).rowCount,
    ).toBe(1);
  });

  it('rolls back a new notification if admission fails, then safely retries', async () => {
    const request = await input();
    // Inject a database failure at the admission write, after the intent insert.
    await pool.query(
      'ALTER TABLE auth_rate_limits ADD CONSTRAINT audit_admission_failure CHECK (count < 1)',
    );
    try {
      await expect(enqueueNotification(pool, request)).rejects.toThrow();
      expect(
        (await pool.query('SELECT 1 FROM notifications WHERE tenant_id = $1', [request.tenantId]))
          .rowCount,
      ).toBe(0);
    } finally {
      await pool.query('ALTER TABLE auth_rate_limits DROP CONSTRAINT audit_admission_failure');
    }
    const retried = await enqueueNotification(pool, request);
    expect(retried.notification.deliveryStatus).toBe('QUEUED');
    expect(retried.deduplicated).toBe(false);
    expect(
      (
        await pool.query('SELECT count FROM auth_rate_limits WHERE subject = $1', [
          request.recipientLimit!.subject,
        ])
      ).rows[0]?.count,
    ).toBe(1);
  });
});
