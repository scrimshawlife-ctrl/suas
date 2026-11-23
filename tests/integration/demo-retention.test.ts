/**
 * R16.5(b) (contributor proposal, not released): STAGING demo retention scrubs and soft-deletes
 * accounts that are not fixture principals, leaves no copy of the address, and keeps the audit.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession } from '../../src/auth/index.js';
import type { StagingAccess } from '../../src/auth/staging-access.js';
import { createUser } from '../../src/identity/users.js';
import { scrubDemoAccounts } from '../../src/staging/demo-retention.js';
import { PUBLISHER_EMAIL } from '../../src/staging/fixture-seed.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { TEST_SESSION_SECRET } from '../helpers/env.js';

const pool: Pool = createTestPool();
const TENANT = randomUUID();
const FIXTURE = randomUUID();
const ADDRESS_TABLES = [
  'users',
  'auth_challenges',
  'notifications',
  'trusted_contacts',
  'auth_rate_limits',
];

const access = (publicDemo: boolean, environment = 'STAGING'): StagingAccess => ({
  environment: environment as StagingAccess['environment'],
  publicSignUp: false,
  publicDemo,
  fixturePrincipals: [{ tenantId: TENANT, userId: FIXTURE }],
});

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

/** A signed-in account created `daysOld` days ago. */
async function account(daysOld: number, userId: string = randomUUID()) {
  const email = syntheticEmail(`retention-${userId.slice(0, 8)}`).toLowerCase();
  await createUser(pool, { userId, tenantId: TENANT, email, status: 'ACTIVE' });
  await pool.query(
    `UPDATE users SET created_at = now() - make_interval(days => $2), display_name = 'Demo D.'
      WHERE user_id = $1`,
    [userId, daysOld],
  );
  await createSession(pool, TEST_SESSION_SECRET, { tenantId: TENANT, userId });
  return { userId, email };
}

/** The address in every table that may hold it: challenges, a send, an invite and a counter. */
async function leaveTrail(userId: string, email: string) {
  const challenge = `INSERT INTO auth_challenges (auth_challenge_id, tenant_id, user_id, method,
      destination, secret_hash, max_attempts, issued_at, expires_at)
    VALUES ($1, $2, $3, 'EMAIL_OTP', $4, 'hash', 5, now() - interval '1 day', now())`;
  await pool.query(challenge, [randomUUID(), TENANT, userId, email]);
  await pool.query(challenge, [randomUUID(), TENANT, null, email]);
  await pool.query(
    `INSERT INTO notifications (notification_id, tenant_id, recipient_user_id, destination,
       reason, channel, consent_basis, template_version)
     VALUES ($1, $2, $3, $4, 'TEST', 'EMAIL', 'TEST', 'v1')`,
    [randomUUID(), TENANT, userId, email],
  );
  await pool.query(
    `INSERT INTO trusted_contacts (trusted_contact_id, tenant_id, veteran_user_id,
       relationship_label, invite_email)
     VALUES ($1, $2, $3, 'friend', $4)`,
    [randomUUID(), TENANT, FIXTURE, email],
  );
  await pool.query(
    `INSERT INTO auth_rate_limits (bucket, subject, window_start, count)
     VALUES ('auth.challenge.issue', $1, now() - interval '3 days', 1)`,
    [email],
  );
}

/** "table.column" for every text column of ADDRESS_TABLES that contains `email`. */
async function columnsHolding(email: string): Promise<string[]> {
  const columns = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1)
        AND data_type IN ('text', 'character varying')`,
    [ADDRESS_TABLES],
  );
  const hits: string[] = [];
  for (const { table_name: table, column_name: column } of columns.rows) {
    const found = await pool.query(
      `SELECT 1 FROM "${table}" WHERE position($1 IN lower("${column}")) > 0 LIMIT 1`,
      [email],
    );
    if ((found.rowCount ?? 0) > 0) hits.push(`${table}.${column}`);
  }
  return hits.sort();
}

const userRow = async (userId: string) =>
  (
    await pool.query<{ deleted_at: Date | null; status: string; email: string | null }>(
      'SELECT deleted_at, status, email FROM users WHERE user_id = $1',
      [userId],
    )
  ).rows[0];

const liveSessions = async (userId: string) =>
  (await pool.query('SELECT 1 FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [userId]))
    .rowCount;

describe('STAGING demo retention', () => {
  it('scrubs an 8-day-old demo account, keeps a 6-day-old one and the fixture user', async () => {
    const fixture = await account(30, FIXTURE);
    const old = await account(8);
    const recent = await account(6);

    expect(await scrubDemoAccounts(pool, { access: access(true) })).toEqual({
      scrubbed: 1,
      challengesDeleted: 0,
    });

    const scrubbed = await userRow(old.userId);
    expect(scrubbed?.deleted_at).not.toBeNull();
    expect(scrubbed?.status).toBe('REVOKED');
    expect(scrubbed?.email).toBeNull();
    expect(await liveSessions(old.userId)).toBe(0);
    for (const kept of [recent, fixture]) {
      const row = await userRow(kept.userId);
      expect(row?.deleted_at).toBeNull();
      expect(row?.email).toBe(kept.email);
      expect(await liveSessions(kept.userId)).toBe(1);
    }
  });

  it('scrubs every non-fixture account regardless of age when the demo is off', async () => {
    await account(30, FIXTURE);
    const fresh = await account(0);
    const publisher = randomUUID();
    await createUser(pool, {
      userId: publisher,
      tenantId: TENANT,
      email: PUBLISHER_EMAIL,
      status: 'SUSPENDED',
    });
    expect((await scrubDemoAccounts(pool, { access: access(false) })).scrubbed).toBe(1);
    expect((await userRow(publisher))?.deleted_at).toBeNull();
    expect((await userRow(fresh.userId))?.deleted_at).not.toBeNull();
    expect((await userRow(FIXTURE))?.deleted_at).toBeNull();
  });

  it('leaves the address in no text column and records an address-free deletion audit', async () => {
    await account(30, FIXTURE);
    const demo = await account(8);
    await leaveTrail(demo.userId, demo.email);
    expect(await columnsHolding(demo.email)).toEqual([
      'auth_challenges.destination',
      'auth_rate_limits.subject',
      'notifications.destination',
      'trusted_contacts.invite_email',
      'users.email',
    ]);

    expect(await scrubDemoAccounts(pool, { access: access(true) })).toEqual({
      scrubbed: 1,
      challengesDeleted: 2,
    });
    expect(await columnsHolding(demo.email)).toEqual([]);
    const invite = await pool.query<{ status: string; invite_email: string }>(
      'SELECT status, invite_email FROM trusted_contacts WHERE veteran_user_id = $1',
      [FIXTURE],
    );
    expect(invite.rows[0]?.status).toBe('REMOVED');
    expect(invite.rows[0]?.invite_email).toMatch(/^removed-[0-9a-f-]{36}@scrubbed\.invalid$/);

    const audit = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE event_type = 'DELETION_REQUEST' AND target_id = $1`,
      [demo.userId],
    );
    expect(audit.rows.map((row) => row.payload)).toEqual([
      {
        fulfillment: 'STAGING_DEMO_RETENTION',
        public_demo: true,
        retention_days: 7,
        automatic_event_purge: false,
      },
    ]);
  });

  it('is a no-op on a second run', async () => {
    await account(30, FIXTURE);
    const demo = await account(8);
    await leaveTrail(demo.userId, demo.email);
    expect((await scrubDemoAccounts(pool, { access: access(true) })).scrubbed).toBe(1);
    expect(await scrubDemoAccounts(pool, { access: access(true) })).toEqual({
      scrubbed: 0,
      challengesDeleted: 0,
    });
    const audits = await pool.query(
      `SELECT 1 FROM audit_events WHERE event_type = 'DELETION_REQUEST' AND target_id = $1`,
      [demo.userId],
    );
    expect(audits.rowCount).toBe(1);
  });

  // R16.5(b) (contributor's call, D-065): an empty registry would make every account look
  // non-fixture, so the sweep scrubs nothing, with the demo on or off.
  it('scrubs nothing when the fixture registry is empty', async () => {
    const older = await account(30);
    const fresh = await account(0);
    for (const publicDemo of [true, false]) {
      const empty = { ...access(publicDemo), fixturePrincipals: [] };
      expect(await scrubDemoAccounts(pool, { access: empty })).toEqual({
        scrubbed: 0,
        challengesDeleted: 0,
      });
    }
    expect((await userRow(older.userId))?.deleted_at).toBeNull();
    expect((await userRow(fresh.userId))?.deleted_at).toBeNull();
  });

  // R16.5(b) (contributor's call, D-065): registry-independent cleanup still runs, so sign-in
  // codes for addresses that never got an account do not pile up while the registry is empty.
  it('still deletes orphan sign-in codes when the fixture registry is empty', async () => {
    await pool.query(
      `INSERT INTO auth_challenges (auth_challenge_id, tenant_id, user_id, method,
          destination, secret_hash, max_attempts, issued_at, expires_at)
        VALUES ($1, $2, NULL, 'EMAIL_OTP', $3, 'hash', 5, now() - interval '8 days', now())`,
      [randomUUID(), TENANT, syntheticEmail('orphan-old')],
    );
    const empty = { ...access(true), fixturePrincipals: [] };
    expect(await scrubDemoAccounts(pool, { access: empty })).toEqual({
      scrubbed: 0,
      challengesDeleted: 1,
    });
  });

  it('refuses to run outside STAGING', async () => {
    for (const environment of ['PRODUCTION', 'LOCAL']) {
      await expect(scrubDemoAccounts(pool, { access: access(true, environment) })).rejects.toThrow(
        /outside STAGING/,
      );
    }
  });
});
