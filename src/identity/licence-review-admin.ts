/**
 * Licence review, the SUAS Admin's side (suas-specs R10.1, proposal; L5, L7.1–L7.3):
 * the queue, the review page, two-admin approval, decline, recuse and revoke.
 *
 * An admin never reviews their own submission, a review they recused from, or a dispute
 * of an approval they made or confirmed. Only a second, different admin's confirmation
 * writes the MANUAL_REVIEW VERIFIED row. Audit payloads hold ids, states and codes only.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import type { ObjectStoragePort } from '../storage/object-storage.js';
import { deleteLicenceImages, getLicenceImage, type LicenceImageSide } from './licence-images.js';
import { auditLicenceReview, LicenceReviewNotFoundError } from './licence-review.js';
import {
  APPROVED_FINGERPRINT_INDEX,
  findReview,
  type LicenceDeclineReason,
  type LicenceReview,
  type LicenceRevokeReason,
} from './licence-review-store.js';

/** Contract version on the MANUAL_REVIEW rows a licence review writes. */
export const LICENCE_REVIEW_CONTRACT_VERSION = 'suas-licence-review-v1';
export const QUEUE_DEFAULT_LIMIT = 25;
export const QUEUE_MAX_LIMIT = 50;

const forbidden = (code: string, message: string) =>
  Object.assign(new Error(message), { code, httpStatus: 403 });
const conflict = (code: string, message: string) =>
  Object.assign(new Error(message), { code, httpStatus: 409 });

export const selfReviewForbidden = () =>
  forbidden('SELF_REVIEW_FORBIDDEN', 'You cannot review your own licence submission.');
export const reviewerRecused = () =>
  forbidden('REVIEWER_RECUSED', 'You are recused from this review.');
export const secondReviewerRequired = () =>
  forbidden('SECOND_REVIEWER_REQUIRED', 'A different SUAS Admin must confirm this approval.');
export const reviewDecided = () =>
  conflict('LICENCE_REVIEW_DECIDED', 'This licence review is already decided.');
export const reviewNotReady = () =>
  conflict('LICENCE_REVIEW_NOT_READY', 'This licence review is not in a state for this step.');
export const fingerprintMissing = () =>
  conflict(
    'LICENCE_FINGERPRINT_MISSING',
    'The licence number or state was not read, so this review cannot be approved. Decline it instead.',
  );
export const alreadyUsed = () =>
  conflict(
    'LICENCE_ALREADY_USED',
    'This licence is on an approved review in this tenant. Decline it as ALREADY_USED.',
  );
export const identityMismatch = () =>
  conflict(
    'LICENCE_IDENTITY_MISMATCH',
    'The licence does not match the details given to VA, so it cannot be approved.',
  );

/** The by-eye checklist (L5.3); approve and confirm need all three ticked. */
export interface Checklist {
  readonly selfieMatches: boolean;
  readonly securityFeatures: boolean;
  readonly wholeCard: boolean;
}

const DECIDED = new Set(['APPROVED', 'DECLINED', 'REVOKED', 'UNREADABLE']);

/** The approved review this one conflicts with, for dispute routing and the record. */
async function conflictingReviewId(db: Queryable, review: LicenceReview) {
  if (review.conflictingReviewId !== undefined) return review.conflictingReviewId;
  if (review.disputeOfReviewId === undefined) return undefined;
  return (await findReview(db, review.tenantId, review.disputeOfReviewId))?.conflictingReviewId;
}

/** Why this admin may not act on this review, or undefined when they may. */
async function accessRefusal(db: Queryable, review: LicenceReview, adminId: string) {
  if (review.userId === adminId) return selfReviewForbidden();
  const recused = await db.query(
    `SELECT 1 FROM veteran_licence_review_recusals WHERE review_id = $1 AND admin_id = $2`,
    [review.reviewId, adminId],
  );
  if ((recused.rowCount ?? 0) > 0) return reviewerRecused();
  // L7.3: a dispute goes to an admin who neither approved nor confirmed the other review.
  if (review.disputeOfReviewId !== undefined) {
    const otherId = await conflictingReviewId(db, review);
    const other =
      otherId === undefined ? undefined : await findReview(db, review.tenantId, otherId);
    if (other?.approvedBy === adminId || other?.confirmedBy === adminId) return reviewerRecused();
  }
  return undefined;
}

/** The review, or 404; then the access rules (403). Locked when `forUpdate`. */
export async function reviewForAdmin(
  db: Queryable,
  input: { tenantId: string; reviewId: string; adminId: string },
  options: { forUpdate?: boolean } = {},
): Promise<LicenceReview> {
  const review = await findReview(db, input.tenantId, input.reviewId, options);
  if (review === undefined) throw new LicenceReviewNotFoundError();
  const refusal = await accessRefusal(db, review, input.adminId);
  if (refusal !== undefined) throw refusal;
  return review;
}

/**
 * §3 "fingerprint in use": null without a fingerprint, else whether an APPROVED review in
 * the tenant holds it now (the one found at read time, under either key, or any since).
 */
export async function fingerprintInUse(db: Queryable, review: LicenceReview) {
  if (review.fingerprint === undefined) return null;
  const result = await db.query(
    `SELECT 1 FROM veteran_licence_reviews
      WHERE tenant_id = $1 AND status = 'APPROVED' AND review_id <> $2
        AND (review_id = $3
             OR (licence_fingerprint = $4 AND licence_fingerprint_key_id = $5))
      LIMIT 1`,
    [
      review.tenantId,
      review.reviewId,
      review.conflictingReviewId ?? null,
      review.fingerprint.hash,
      review.fingerprint.keyId,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface QueueItem {
  readonly reviewId: string;
  readonly status: LicenceReview['status'];
  readonly submittedAt: Date;
  readonly isDispute: boolean;
}

const encodeCursor = (item: QueueItem) =>
  Buffer.from(`${item.submittedAt.toISOString()}|${item.reviewId}`).toString('base64url');
function decodeCursor(cursor: string): [string, string] | undefined {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return at !== undefined && id !== undefined && !Number.isNaN(Date.parse(at))
    ? [at, id]
    : undefined;
}

/**
 * L5.1: reviews waiting for a decision, oldest first, without the admin's own, the ones
 * they recused from, or disputes of an approval they made or confirmed. No names.
 */
export async function listReviewQueue(
  db: Queryable,
  input: { tenantId: string; adminId: string; limit: number; cursor?: string | undefined },
): Promise<{ items: QueueItem[]; nextCursor: string | undefined }> {
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const result = await db.query<{
    review_id: string;
    status: LicenceReview['status'];
    created_at: Date;
    is_dispute: boolean;
  }>(
    `SELECT r.review_id, r.status, r.created_at, r.dispute_of_review_id IS NOT NULL AS is_dispute
       FROM veteran_licence_reviews r
       LEFT JOIN veteran_licence_reviews d ON d.review_id = r.dispute_of_review_id
       LEFT JOIN veteran_licence_reviews c
              ON c.review_id = COALESCE(r.conflicting_review_id, d.conflicting_review_id)
      WHERE r.tenant_id = $1 AND r.status IN ('AWAITING_REVIEW', 'AWAITING_CONFIRMATION')
        AND r.user_id <> $2
        AND NOT EXISTS (SELECT 1 FROM veteran_licence_review_recusals x
                         WHERE x.review_id = r.review_id AND x.admin_id = $2)
        AND (r.dispute_of_review_id IS NULL
             OR c.review_id IS NULL
             OR ($2 IS DISTINCT FROM c.approved_by AND $2 IS DISTINCT FROM c.confirmed_by))
        AND ($3::timestamptz IS NULL OR (r.created_at, r.review_id) > ($3, $4::uuid))
      ORDER BY r.created_at, r.review_id
      LIMIT $5`,
    [input.tenantId, input.adminId, after?.[0] ?? null, after?.[1] ?? null, input.limit + 1],
  );
  const items = result.rows.slice(0, input.limit).map((row) => ({
    reviewId: row.review_id,
    status: row.status,
    submittedAt: row.created_at,
    isDispute: row.is_dispute,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      result.rows.length > input.limit && last !== undefined ? encodeCursor(last) : undefined,
  };
}

export interface ReviewDetail {
  readonly review: LicenceReview;
  readonly fingerprintInUse: boolean | null;
  readonly conflicting: LicenceReview | undefined;
  readonly viewer: {
    readonly canApprove: boolean;
    readonly canConfirm: boolean;
    readonly canDecline: boolean;
    readonly canRevoke: boolean;
  };
}

/** L5.2–L5.3 and L7.3: the review page, with the conflicting review's record for a dispute. */
export async function readReviewDetail(
  db: Queryable,
  input: { tenantId: string; reviewId: string; adminId: string },
): Promise<ReviewDetail> {
  const review = await reviewForAdmin(db, input);
  const otherId = await conflictingReviewId(db, review);
  const conflicting =
    otherId === undefined ? undefined : await findReview(db, input.tenantId, otherId);
  return {
    review,
    fingerprintInUse: await fingerprintInUse(db, review),
    conflicting,
    viewer: {
      canApprove: review.status === 'AWAITING_REVIEW',
      canConfirm: review.status === 'AWAITING_CONFIRMATION' && review.approvedBy !== input.adminId,
      canDecline: review.status === 'AWAITING_REVIEW' || review.status === 'AWAITING_CONFIRMATION',
      canRevoke: review.status === 'APPROVED',
    },
  };
}

/** One stored image for the review page; undefined once deleted or gone from storage. */
export async function readReviewImage(
  db: Queryable,
  storage: ObjectStoragePort,
  input: { tenantId: string; reviewId: string; adminId: string; side: LicenceImageSide },
): Promise<Uint8Array | undefined> {
  const review = await reviewForAdmin(db, input);
  if (!review.images[input.side]) return undefined;
  return getLicenceImage(storage, review.reviewId, input.side);
}

export interface CommandInput {
  readonly tenantId: string;
  readonly reviewId: string;
  readonly adminId: string;
  readonly correlationId?: string | undefined;
}

const adminEvent = (input: CommandInput, type: string, action: string) => ({
  type,
  action,
  actor: { type: 'SUAS_ADMIN' as const, id: input.adminId },
  correlationId: input.correlationId,
});

/** The approval rules every approving step re-checks (L5.4). */
async function assertApprovable(tx: Queryable, review: LicenceReview) {
  if (review.fingerprint === undefined) throw fingerprintMissing();
  if (await fingerprintInUse(tx, review)) throw alreadyUsed();
  if (review.identityMatch !== 'YES') throw identityMismatch();
}

/** L5.4: the first approval. No VERIFIED row yet; a second admin must confirm. */
export async function approveReview(
  tx: Queryable,
  input: CommandInput & { checklist: Checklist },
): Promise<LicenceReview> {
  const review = await reviewForAdmin(tx, input, { forUpdate: true });
  if (DECIDED.has(review.status)) throw reviewDecided();
  if (review.status !== 'AWAITING_REVIEW') throw reviewNotReady();
  await assertApprovable(tx, review);
  await tx.query(
    `UPDATE veteran_licence_reviews
        SET status = 'AWAITING_CONFIRMATION', approved_by = $2, approved_at = now(),
            selfie_matches = $3, security_features_present = $4, whole_card = $5,
            updated_at = now()
      WHERE review_id = $1`,
    [
      review.reviewId,
      input.adminId,
      input.checklist.selfieMatches,
      input.checklist.securityFeatures,
      input.checklist.wholeCard,
    ],
  );
  await auditLicenceReview(
    tx,
    review,
    adminEvent(input, 'LICENCE_REVIEW_DECIDED', 'DECIDE_LICENCE_REVIEW'),
    {
      outcome: 'APPROVAL_PROPOSED',
      decline_reason: null,
    },
  );
  return reviewForAdmin(tx, input);
}

const isApprovedFingerprintConflict = (error: unknown) => {
  const pg = error as { code?: unknown; constraint?: unknown } | null;
  return pg?.code === '23505' && pg.constraint === APPROVED_FINGERPRINT_INDEX;
};

/**
 * L5.5: a second, different admin confirms. The review becomes APPROVED, the MANUAL_REVIEW
 * VERIFIED row opens the gate, and the images and reading are deleted.
 */
export async function confirmReview(
  tx: Queryable,
  storage: ObjectStoragePort,
  input: CommandInput & { checklist: Checklist },
): Promise<LicenceReview> {
  const review = await reviewForAdmin(tx, input, { forUpdate: true });
  if (DECIDED.has(review.status)) throw reviewDecided();
  if (review.status !== 'AWAITING_CONFIRMATION') throw reviewNotReady();
  if (review.approvedBy === input.adminId) throw secondReviewerRequired();
  await assertApprovable(tx, review);
  await tx.query('SAVEPOINT licence_confirm');
  try {
    await tx.query(
      `UPDATE veteran_licence_reviews
          SET status = 'APPROVED', confirmed_by = $2, confirmed_at = now(),
              confirm_selfie_matches = $3, confirm_security_features_present = $4,
              confirm_whole_card = $5, decided_at = now(), front_key = NULL, back_key = NULL,
              selfie_key = NULL, read_result = NULL, updated_at = now()
        WHERE review_id = $1`,
      [
        review.reviewId,
        input.adminId,
        input.checklist.selfieMatches,
        input.checklist.securityFeatures,
        input.checklist.wholeCard,
      ],
    );
  } catch (error) {
    if (!isApprovedFingerprintConflict(error)) throw error;
    await tx.query('ROLLBACK TO SAVEPOINT licence_confirm');
    throw alreadyUsed();
  }
  const verificationId = randomUUID();
  await tx.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        verified_at, settled_at)
     VALUES ($1, $2, $3, 'MANUAL_REVIEW', 'VERIFIED', 'SUAS', $4, clock_timestamp(),
             clock_timestamp())`,
    [verificationId, review.tenantId, review.userId, LICENCE_REVIEW_CONTRACT_VERSION],
  );
  await deleteLicenceImages(storage, review.reviewId);
  await auditLicenceReview(
    tx,
    review,
    adminEvent(input, 'LICENCE_REVIEW_CONFIRMED', 'CONFIRM_LICENCE_REVIEW'),
    {
      status: 'APPROVED',
      verification_id: verificationId,
    },
  );
  return reviewForAdmin(tx, input);
}

/** L5.7: one admin declines from either waiting state; no second admin is needed. */
export async function declineReview(
  tx: Queryable,
  storage: ObjectStoragePort,
  input: CommandInput & { reason: LicenceDeclineReason },
): Promise<LicenceReview> {
  const review = await reviewForAdmin(tx, input, { forUpdate: true });
  if (DECIDED.has(review.status)) throw reviewDecided();
  if (review.status === 'READING') throw reviewNotReady();
  await tx.query(
    `UPDATE veteran_licence_reviews
        SET status = 'DECLINED', decline_reason = $2, declined_by = $3, decided_at = now(),
            front_key = NULL, back_key = NULL, selfie_key = NULL, read_result = NULL,
            licence_fingerprint = NULL, licence_fingerprint_key_id = NULL, updated_at = now()
      WHERE review_id = $1`,
    [review.reviewId, input.reason, input.adminId],
  );
  await deleteLicenceImages(storage, review.reviewId);
  await auditLicenceReview(
    tx,
    review,
    adminEvent(input, 'LICENCE_REVIEW_DECIDED', 'DECIDE_LICENCE_REVIEW'),
    {
      outcome: 'DECLINED',
      decline_reason: input.reason,
    },
  );
  return reviewForAdmin(tx, input);
}

/** L5.6: hides the review from this admin and refuses their commands on it. */
export async function recuseFromReview(tx: Queryable, input: CommandInput): Promise<void> {
  const review = await findReview(tx, input.tenantId, input.reviewId, { forUpdate: true });
  if (review === undefined) throw new LicenceReviewNotFoundError();
  if (review.userId === input.adminId) throw selfReviewForbidden();
  const inserted = await tx.query(
    `INSERT INTO veteran_licence_review_recusals (review_id, admin_id, tenant_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [review.reviewId, input.adminId, input.tenantId],
  );
  if ((inserted.rowCount ?? 0) === 0) return;
  await auditLicenceReview(
    tx,
    review,
    adminEvent(input, 'LICENCE_REVIEW_RECUSED', 'RECUSE_LICENCE_REVIEW'),
    {},
  );
}

/**
 * L7.1–L7.2: revokes an approval. FRAUD writes a REVOKED row (which outranks every method
 * and releases the VA identity); REVIEW_ERROR writes a newer MANUAL_REVIEW NOT_CONFIRMED
 * row, so only that method's approval stops counting. Both free the fingerprint.
 */
export async function revokeReview(
  tx: Queryable,
  input: CommandInput & { reason: LicenceRevokeReason },
): Promise<LicenceReview> {
  const review = await reviewForAdmin(tx, input, { forUpdate: true });
  if (review.status === 'REVOKED') throw reviewDecided();
  if (review.status !== 'APPROVED') throw reviewNotReady();
  await tx.query(
    `UPDATE veteran_licence_reviews
        SET status = 'REVOKED', revoke_reason = $2, revoked_by = $3, revoked_at = now(),
            licence_fingerprint = NULL, licence_fingerprint_key_id = NULL, updated_at = now()
      WHERE review_id = $1`,
    [review.reviewId, input.reason, input.adminId],
  );
  const verificationId = randomUUID();
  await tx.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        settled_at)
     VALUES ($1, $2, $3, 'MANUAL_REVIEW', $4::suas_veteran_verification_status, 'SUAS', $5,
             clock_timestamp())`,
    [
      verificationId,
      review.tenantId,
      review.userId,
      input.reason === 'FRAUD' ? 'REVOKED' : 'NOT_CONFIRMED',
      LICENCE_REVIEW_CONTRACT_VERSION,
    ],
  );
  await auditLicenceReview(
    tx,
    review,
    adminEvent(input, 'LICENCE_REVIEW_REVOKED', 'REVOKE_LICENCE_REVIEW'),
    {
      revoke_reason: input.reason,
      verification_id: verificationId,
    },
  );
  return reviewForAdmin(tx, input);
}
