/**
 * Trusted Circle membership.
 *
 * Spec citations:
 * - SUAS-specs TRUSTED_CIRCLE.md §1 — membership alone grants no visibility
 * - §2 lifecycle INVITED → ACCEPTED → SUSPENDED | REMOVED | REVOKED
 * - §3 invite/accept; consent is not implied by accept
 * - §4 the relationship label is not a permission
 * - §6 membership is evaluated before grants
 * - §7 transitions are audited
 * - SUAS-specs DOMAIN_MODEL.md §4 "TrustedContact"
 *
 * This module holds the relationship only. Every permission lives on a Consent
 * Grant, and nothing here can grant visibility.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { normalizeDestination } from '../auth/secrets.js';
import { appendAuditEvent, type ActorType } from '../events/index.js';

export const TRUSTED_CONTACT_STATUSES = [
  'INVITED',
  'ACCEPTED',
  'SUSPENDED',
  'REMOVED',
  'REVOKED',
] as const;
export type TrustedContactStatus = (typeof TRUSTED_CONTACT_STATUSES)[number];

/**
 * Statuses in which a contact may be considered at all. TRUSTED_CIRCLE.md §2:
 * INVITED has no data visibility, and SUSPENDED evaluates as deny while
 * suspended even though grants remain.
 */
const USABLE_STATUSES: readonly TrustedContactStatus[] = ['ACCEPTED'];

/**
 * Terminal statuses. TRUSTED_CIRCLE.md §2 ends the lifecycle at REMOVED/REVOKED;
 * a relationship past either is over and must not transition again (in
 * particular, never back to ACCEPTED — that would silently restore a removed
 * contact's membership and, with any leftover grant, their access).
 * Re-establishing a relationship requires a fresh invite.
 */
const TERMINAL_STATUSES: readonly TrustedContactStatus[] = ['REMOVED', 'REVOKED'];

export interface TrustedContact {
  readonly trustedContactId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly contactUserId: string | undefined;
  readonly relationshipLabel: string;
  readonly status: TrustedContactStatus;
}

interface ContactRow {
  trusted_contact_id: string;
  tenant_id: string;
  veteran_user_id: string;
  contact_user_id: string | null;
  relationship_label: string;
  status: TrustedContactStatus;
}

const CONTACT_COLUMNS = `
  trusted_contact_id, tenant_id, veteran_user_id, contact_user_id,
  relationship_label, status
`;

function toContact(row: ContactRow): TrustedContact {
  return {
    trustedContactId: row.trusted_contact_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    contactUserId: row.contact_user_id ?? undefined,
    relationshipLabel: row.relationship_label,
    status: row.status,
  };
}

export class TrustedContactChannelRequiredError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super(
      'A Trusted Contact invite requires an email address or a phone number ' +
        '(SUAS-specs TRUSTED_CIRCLE.md §3.1).',
    );
    this.name = 'TrustedContactChannelRequiredError';
  }
}

export class TrustedContactTerminalError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(status: TrustedContactStatus) {
    super(
      `A ${status} Trusted Contact is in a terminal state and cannot change status ` +
        `(SUAS-specs TRUSTED_CIRCLE.md §2). Re-establishing the relationship requires a new invite.`,
    );
    this.name = 'TrustedContactTerminalError';
  }
}

export interface InviteTrustedContactInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly relationshipLabel: string;
  readonly inviteEmail?: string;
  readonly invitePhone?: string;
  readonly inviteTemplateVersion?: string;
}

/**
 * Create an invite.
 *
 * TRUSTED_CIRCLE.md §3.2: the system contacts only the addresses the veteran
 * provided. Delivery itself belongs to Notifications (Slice 8); this records the
 * relationship. TRUSTED_CIRCLE.md §11: an invite must not emit
 * `TRUSTED_CONTACT_ALERTED`, so callers emit `TRUSTED_CONTACT_INVITED` only.
 */
export async function inviteTrustedContact(
  db: Queryable,
  input: InviteTrustedContactInput,
): Promise<TrustedContact> {
  const email = input.inviteEmail === undefined ? null : normalizeDestination(input.inviteEmail);
  const phone = input.invitePhone === undefined ? null : normalizeDestination(input.invitePhone);
  if (email === null && phone === null) {
    throw new TrustedContactChannelRequiredError();
  }

  const result = await db.query<ContactRow>(
    `INSERT INTO trusted_contacts
       (trusted_contact_id, tenant_id, veteran_user_id, relationship_label,
        invite_email, invite_phone, invite_template_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${CONTACT_COLUMNS}`,
    [
      randomUUID(),
      input.tenantId,
      input.veteranUserId,
      input.relationshipLabel,
      email,
      phone,
      input.inviteTemplateVersion ?? null,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Trusted contact insert returned no row.');
  return toContact(row);
}

/**
 * The Veteran's open invite to the same address, if any, so a second invite returns it
 * instead of emailing that person again. Locks the Veteran's user row first, which
 * serializes their invite commands so two concurrent ones cannot both insert.
 */
export async function findOpenInviteToAddress(
  db: Queryable,
  input: Pick<
    InviteTrustedContactInput,
    'tenantId' | 'veteranUserId' | 'inviteEmail' | 'invitePhone'
  >,
): Promise<TrustedContact | undefined> {
  await db.query(`SELECT 1 FROM users WHERE tenant_id = $1 AND user_id = $2 FOR UPDATE`, [
    input.tenantId,
    input.veteranUserId,
  ]);
  const email = input.inviteEmail === undefined ? null : normalizeDestination(input.inviteEmail);
  const phone = input.invitePhone === undefined ? null : normalizeDestination(input.invitePhone);
  const result = await db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM trusted_contacts
      WHERE tenant_id = $1 AND veteran_user_id = $2 AND status = 'INVITED'
        AND (invite_email = $3 OR invite_phone = $4)
      ORDER BY invited_at LIMIT 1`,
    [input.tenantId, input.veteranUserId, email, phone],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toContact(row);
}

/**
 * Accept an invite, optionally binding an enrolled User.
 *
 * TRUSTED_CIRCLE.md §3.3: a User is bound only when their enrolled email or phone is
 * the address the veteran invited (SECURITY.md §5), so another signed-in person
 * holding the id matches nothing. §3.4: acceptance issues no grants.
 */
export async function acceptTrustedContact(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
  contactUserId?: string,
): Promise<TrustedContact | undefined> {
  const result = await db.query<ContactRow>(
    `UPDATE trusted_contacts t
       SET status = 'ACCEPTED', accepted_at = now(), updated_at = now(),
           contact_user_id = COALESCE($3, t.contact_user_id)
     WHERE t.tenant_id = $1 AND t.trusted_contact_id = $2 AND t.status = 'INVITED'
       AND ($3::uuid IS NULL OR EXISTS (
         SELECT 1 FROM users u
          WHERE u.tenant_id = t.tenant_id AND u.user_id = $3 AND u.deleted_at IS NULL
            AND ((t.invite_email IS NOT NULL AND lower(u.email) = t.invite_email)
              OR (t.invite_phone IS NOT NULL AND u.phone = t.invite_phone))))
     RETURNING ${CONTACT_COLUMNS}`,
    [tenantId, trustedContactId, contactUserId ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toContact(row);
}

/**
 * Move a contact to a terminal or suspended state.
 *
 * TRUSTED_CIRCLE.md §7: each transition is audited by the caller. Grants are not
 * touched here — §6 requires membership to be evaluated before grants, so a
 * removed contact is denied regardless of leftover grants. A caller that wants
 * grants revoked as part of removal revokes them explicitly and emits
 * `CONSENT_REVOKED` per grant.
 */
export async function setTrustedContactStatus(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
  status: Exclude<TrustedContactStatus, 'INVITED'>,
): Promise<TrustedContact | undefined> {
  const terminal = status === 'REMOVED' || status === 'REVOKED';
  // The `status <> ALL(terminal)` predicate makes terminal immutability atomic:
  // a REMOVED/REVOKED row matches nothing and is never re-opened, even under a
  // concurrent transition.
  const result = await db.query<ContactRow>(
    `UPDATE trusted_contacts
       SET status = $3::suas_trusted_contact_status,
           ended_at = CASE WHEN $4::boolean THEN now() ELSE ended_at END,
           updated_at = now()
     WHERE tenant_id = $1 AND trusted_contact_id = $2
       AND status <> ALL($5::suas_trusted_contact_status[])
     RETURNING ${CONTACT_COLUMNS}`,
    [tenantId, trustedContactId, status, terminal, TERMINAL_STATUSES],
  );
  const row = result.rows[0];
  if (row === undefined) {
    // Distinguish "no such contact" (undefined, as before) from "refused
    // because the contact is already terminal".
    const existing = await findTrustedContact(db, tenantId, trustedContactId);
    if (existing !== undefined && TERMINAL_STATUSES.includes(existing.status)) {
      throw new TrustedContactTerminalError(existing.status);
    }
    return undefined;
  }
  return toContact(row);
}

const TRANSITION_EVENT = {
  INVITE: 'TRUSTED_CONTACT_INVITED',
  ACCEPT: 'TRUSTED_CONTACT_ACCEPTED',
  REMOVE: 'TRUSTED_CONTACT_REMOVED',
} as const;

/**
 * TRUSTED_CIRCLE.md §3.4, §7: every membership transition writes an Audit Event.
 * The payload carries the resulting status only, never the invite addresses.
 */
export async function auditTrustedContactTransition(
  db: Queryable,
  input: {
    readonly contact: TrustedContact;
    readonly transition: keyof typeof TRANSITION_EVENT;
    readonly actorType: ActorType;
    readonly actorId: string;
    readonly correlationId?: string;
  },
): Promise<void> {
  await appendAuditEvent(db, {
    eventType: TRANSITION_EVENT[input.transition],
    action: `${input.transition}_TRUSTED_CONTACT`,
    targetType: 'TrustedContact',
    targetId: input.contact.trustedContactId,
    aggregateType: 'TrustedContact',
    aggregateId: input.contact.trustedContactId,
    tenantId: input.contact.tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    payload: { status: input.contact.status },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
}

export async function findTrustedContact(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
): Promise<TrustedContact | undefined> {
  const result = await db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM trusted_contacts
     WHERE tenant_id = $1 AND trusted_contact_id = $2`,
    [tenantId, trustedContactId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toContact(row);
}

/** The veteran's circle. Nobody who accepts a request receives this roster by default (§8). */
export async function listTrustedCircle(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<TrustedContact[]> {
  const result = await db.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS} FROM trusted_contacts
     WHERE tenant_id = $1 AND veteran_user_id = $2
     ORDER BY invited_at`,
    [tenantId, veteranUserId],
  );
  return result.rows.map(toContact);
}

export interface EmailableContact {
  readonly trustedContactId: string;
  readonly contactUserId: string | undefined;
  readonly inviteEmail: string;
}

/**
 * ACCEPTED contacts of a veteran that have an invite email, with that address.
 * Membership only: callers still evaluate a Consent Grant per contact. Kept
 * apart from `TrustedContact` so destinations do not travel with ordinary reads.
 */
export async function listAcceptedContactsWithEmail(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<EmailableContact[]> {
  const result = await db.query<{
    trusted_contact_id: string;
    contact_user_id: string | null;
    invite_email: string;
  }>(
    `SELECT trusted_contact_id, contact_user_id, invite_email FROM trusted_contacts
     WHERE tenant_id = $1 AND veteran_user_id = $2 AND status = 'ACCEPTED'
       AND invite_email IS NOT NULL
     ORDER BY invited_at, trusted_contact_id`,
    [tenantId, veteranUserId],
  );
  return result.rows.map((row) => ({
    trustedContactId: row.trusted_contact_id,
    contactUserId: row.contact_user_id ?? undefined,
    inviteEmail: row.invite_email,
  }));
}

/** The address an invite goes to. Kept out of `TrustedContact` like the alert reads above. */
export async function findInviteEmail(
  db: Queryable,
  tenantId: string,
  trustedContactId: string,
): Promise<string | undefined> {
  const result = await db.query<{ invite_email: string | null }>(
    `SELECT invite_email FROM trusted_contacts
     WHERE tenant_id = $1 AND trusted_contact_id = $2 AND status = 'INVITED'`,
    [tenantId, trustedContactId],
  );
  return result.rows[0]?.invite_email ?? undefined;
}

export interface PendingInvitation {
  readonly trustedContactId: string;
  readonly veteranDisplayName: string | undefined;
  readonly relationshipLabel: string;
}

/**
 * Invites still INVITED to the caller's enrolled email, which sign-in by email code has
 * proved (R9.4, contributor proposal, specs #72). Only the inviting Veteran's display
 * name and the relationship label leave this read; invites do not expire.
 */
export async function listPendingInvitations(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<PendingInvitation[]> {
  const result = await db.query<{
    trusted_contact_id: string;
    display_name: string | null;
    relationship_label: string;
  }>(
    `SELECT t.trusted_contact_id, v.display_name, t.relationship_label
       FROM users me
       JOIN trusted_contacts t
         ON t.tenant_id = me.tenant_id AND t.status = 'INVITED'
        AND t.invite_email IS NOT NULL AND t.invite_email = lower(me.email)
        AND t.veteran_user_id <> me.user_id
       JOIN users v ON v.tenant_id = t.tenant_id AND v.user_id = t.veteran_user_id
      WHERE me.tenant_id = $1 AND me.user_id = $2 AND me.deleted_at IS NULL
        AND me.status = 'ACTIVE' AND v.deleted_at IS NULL AND v.status = 'ACTIVE'
      ORDER BY t.invited_at, t.trusted_contact_id`,
    [tenantId, userId],
  );
  return result.rows.map((row) => ({
    trustedContactId: row.trusted_contact_id,
    veteranDisplayName: row.display_name ?? undefined,
    relationshipLabel: row.relationship_label,
  }));
}

/**
 * Whether a contact's membership permits any use at all, before grants are even
 * considered. TRUSTED_CIRCLE.md §6: "evaluate membership first".
 */
export function membershipPermitsUse(contact: TrustedContact | undefined): boolean {
  return contact !== undefined && USABLE_STATUSES.includes(contact.status);
}
