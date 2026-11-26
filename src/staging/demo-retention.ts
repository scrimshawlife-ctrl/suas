/**
 * R16.5(b) (contributor proposal, not released): STAGING scrubs and soft-deletes every account that
 * is not a fixture principal, past the retention window while the demo runs, else all of them.
 * Events are kept (PRIVACY.md §2, §9); a scrubbed account is never selected again. The fixture
 * seed's publisher account is kept too.
 */

import type { Pool, PoolClient } from 'pg';
import { revokeAllUserSessions } from '../auth/index.js';
import { publicDemoActive, type StagingAccess } from '../auth/staging-access.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import { softDeleteUser } from '../identity/users.js';
import { DELETION_REQUEST_AUDIT_EVENT_TYPE } from '../privacy/deletion-drill.js';
import { PUBLISHER_EMAIL } from './fixture-seed.js';

const DEMO_RETENTION_DAYS = 7;

/** Rate-limit windows are at most a day long, so a window older than this has fully elapsed. */
const ELAPSED_RATE_LIMIT_WINDOW_DAYS = 2;

export interface DemoRetentionResult {
  readonly scrubbed: number;
  readonly challengesDeleted: number;
}

interface Candidate {
  readonly tenant_id: string;
  readonly user_id: string;
}

/**
 * A scrub candidate: live, not a fixture principal ($1, $2), past the window while the demo runs
 * ($3–$5) and not the publisher ($6). The scan holds no lock, so the per-account lock re-checks it.
 */
const CANDIDATE_CONDITION = `deleted_at IS NULL
  AND (lower(tenant_id::text), lower(user_id::text)) NOT IN (
        SELECT * FROM unnest($1::text[], $2::text[]))
  AND ($3::boolean = false OR created_at < $4::timestamptz - make_interval(days => $5))
  AND (email IS NULL OR lower(email) <> lower($6))`;

export async function scrubDemoAccounts(
  db: Pool,
  options: { access: StagingAccess; now?: Date; retentionDays?: number },
): Promise<DemoRetentionResult> {
  const { access } = options;
  if (access.environment !== 'STAGING') {
    throw new Error(`Refusing demo retention outside STAGING: environment "${access.environment}"`);
  }
  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? DEMO_RETENTION_DAYS;
  const demoActive = publicDemoActive(access);

  // R16.5(b) (contributor's call, D-065): with no registry every account looks non-fixture, so
  // the account scrub is skipped (startup refuses the demo then); the cleanup below still runs.
  const params = [
    access.fixturePrincipals.map((entry) => entry.tenantId.toLowerCase()),
    access.fixturePrincipals.map((entry) => entry.userId.toLowerCase()),
    demoActive,
    now,
    retentionDays,
    PUBLISHER_EMAIL,
  ];
  const candidates =
    access.fixturePrincipals.length === 0
      ? { rows: [] as Candidate[] }
      : await db.query<Candidate>(
          `SELECT tenant_id::text, user_id::text FROM users
            WHERE ${CANDIDATE_CONDITION} ORDER BY created_at`,
          params,
        );

  let scrubbed = 0;
  let challengesDeleted = 0;
  for (const candidate of candidates.rows) {
    const deleted = await withTransaction(db, (tx) =>
      scrubAccount(tx, candidate, { demoActive, retentionDays, params }),
    );
    if (deleted === undefined) continue;
    scrubbed += 1;
    challengesDeleted += deleted;
  }

  // Refused and over-cap sign-ups have no user; their challenges age out with the same window.
  const orphans = await db.query(
    `DELETE FROM auth_challenges
      WHERE user_id IS NULL AND issued_at < $1::timestamptz - make_interval(days => $2)`,
    [now, retentionDays],
  );
  await db.query(
    `DELETE FROM auth_rate_limits
      WHERE window_start < $1::timestamptz - make_interval(days => $2)`,
    [now, ELAPSED_RATE_LIMIT_WINDOW_DAYS],
  );
  return { scrubbed, challengesDeleted: challengesDeleted + (orphans.rowCount ?? 0) };
}

/** One account's scrub; undefined when another run got there first. Returns challenges deleted. */
async function scrubAccount(
  tx: PoolClient,
  { tenant_id: tenantId, user_id: userId }: Candidate,
  policy: { demoActive: boolean; retentionDays: number; params: readonly unknown[] },
): Promise<number | undefined> {
  // Review 2026-11-24 (#369): an account that stopped qualifying since the scan, or that another
  // run already scrubbed, is left alone.
  const locked = await tx.query<{ email: string | null; phone: string | null }>(
    `SELECT email, phone FROM users
      WHERE ${CANDIDATE_CONDITION} AND tenant_id = $7 AND user_id = $8 FOR UPDATE`,
    [...policy.params, tenantId, userId],
  );
  const contact = locked.rows[0];
  if (contact === undefined) return undefined;

  await appendAuditEvent(tx, {
    eventType: DELETION_REQUEST_AUDIT_EVENT_TYPE,
    action: 'RECORD',
    targetType: 'user',
    targetId: userId,
    aggregateType: 'User',
    aggregateId: userId,
    tenantId,
    actorType: 'SYSTEM',
    actorId: 'staging_demo_retention',
    payload: {
      fulfillment: 'STAGING_DEMO_RETENTION',
      public_demo: policy.demoActive,
      retention_days: policy.retentionDays,
      automatic_event_purge: false,
    },
  });
  await softDeleteUser(tx, tenantId, userId);
  await revokeAllUserSessions(tx, userId, 'USER_REVOKED');
  await tx.query(
    `UPDATE users SET email = NULL, phone = NULL, display_name = NULL, updated_at = now()
      WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );

  // Review 2026-11-24 (#369): an address is unique per tenant only, so every branch below is
  // scoped to this account's tenant; another tenant's rows for the same address are kept.
  const { email, phone } = contact;
  const challenges = await tx.query(
    `DELETE FROM auth_challenges
      WHERE tenant_id = $1
        AND (user_id = $2 OR lower(destination) = lower($3) OR destination = $4)`,
    [tenantId, userId, email, phone],
  );
  await tx.query(
    `UPDATE notifications SET destination = NULL, updated_at = now()
      WHERE tenant_id = $1 AND destination IS NOT NULL
        AND (recipient_user_id = $2 OR lower(destination) = lower($3) OR destination = $4)`,
    [tenantId, userId, email, phone],
  );
  // The CHECK needs an invite channel, so the address becomes a per-row placeholder.
  await tx.query(
    `UPDATE trusted_contacts
        SET invite_email = 'removed-' || trusted_contact_id || '@scrubbed.invalid',
            invite_phone = NULL, status = 'REMOVED',
            ended_at = COALESCE(ended_at, now()), updated_at = now()
      WHERE tenant_id = $1
        AND (veteran_user_id = $2 OR contact_user_id = $2
             OR lower(invite_email) = lower($3) OR invite_phone = $4)`,
    [tenantId, userId, email, phone],
  );
  return challenges.rowCount ?? 0;
}
