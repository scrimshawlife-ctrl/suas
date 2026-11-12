/**
 * `veteran_licence_reviews` rows (suas-specs R10.1, proposal; migration 0024). Queries
 * only: the rules for when a row may change live in licence-review.ts. No query here
 * reads or writes a licence field value other than the shown reading.
 */

import type { Queryable } from '../db/transaction.js';
import type { KeyedHash } from './fingerprint-keys.js';
import type { IdentityMatch } from './licence-checks.js';
import type { LicenceImageSide } from './licence-images.js';
import type { LicenceFailureClass, LicenceReading } from './licence-reader.js';

export const LICENCE_REVIEW_STATUSES = [
  'READING',
  'UNREADABLE',
  'AWAITING_REVIEW',
  'AWAITING_CONFIRMATION',
  'APPROVED',
  'DECLINED',
  'REVOKED',
] as const;
export type LicenceReviewStatus = (typeof LICENCE_REVIEW_STATUSES)[number];
export const OPEN_STATUSES: readonly LicenceReviewStatus[] = [
  'READING',
  'AWAITING_REVIEW',
  'AWAITING_CONFIRMATION',
];

export const LICENCE_DECLINE_REASONS = [
  'NO_VETERAN_DESIGNATION',
  'UNREADABLE',
  'EXPIRED',
  'IDENTITY_MISMATCH',
  'SELFIE_MISMATCH',
  'ALREADY_USED',
  'OTHER',
] as const;
export type LicenceDeclineReason = (typeof LICENCE_DECLINE_REASONS)[number];

export const LICENCE_REVOKE_REASONS = ['FRAUD', 'REVIEW_ERROR'] as const;
export type LicenceRevokeReason = (typeof LICENCE_REVOKE_REASONS)[number];

/** The unique index that keeps one approved licence per tenant. */
export const APPROVED_FINGERPRINT_INDEX = 'veteran_licence_reviews_fingerprint_approved_key';

export interface LicenceReview {
  readonly reviewId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly status: LicenceReviewStatus;
  readonly vaAttemptId: string;
  readonly noticeVersion: string;
  readonly disputeOfReviewId: string | undefined;
  readonly images: Readonly<Record<LicenceImageSide, boolean>>;
  readonly reading: LicenceReading | undefined;
  readonly identityMatch: IdentityMatch | undefined;
  readonly fingerprint: KeyedHash | undefined;
  readonly conflictingReviewId: string | undefined;
  readonly failureClass: LicenceFailureClass | undefined;
  readonly declineReason: LicenceDeclineReason | undefined;
  readonly revokeReason: LicenceRevokeReason | undefined;
  readonly approvedBy: string | undefined;
  readonly approvedAt: Date | undefined;
  readonly confirmedBy: string | undefined;
  readonly confirmedAt: Date | undefined;
  readonly declinedBy: string | undefined;
  readonly revokedBy: string | undefined;
  readonly revokedAt: Date | undefined;
  readonly readAt: Date | undefined;
  readonly decidedAt: Date | undefined;
  readonly submittedAt: Date;
}

interface ReviewRow {
  review_id: string;
  tenant_id: string;
  user_id: string;
  status: LicenceReviewStatus;
  va_attempt_id: string;
  notice_version: string;
  dispute_of_review_id: string | null;
  front_key: string | null;
  back_key: string | null;
  selfie_key: string | null;
  read_result: LicenceReading | null;
  identity_match: IdentityMatch | null;
  licence_fingerprint: string | null;
  licence_fingerprint_key_id: string | null;
  conflicting_review_id: string | null;
  failure_class: LicenceFailureClass | null;
  decline_reason: LicenceDeclineReason | null;
  revoke_reason: LicenceRevokeReason | null;
  approved_by: string | null;
  approved_at: Date | null;
  confirmed_by: string | null;
  confirmed_at: Date | null;
  declined_by: string | null;
  revoked_by: string | null;
  revoked_at: Date | null;
  read_at: Date | null;
  decided_at: Date | null;
  created_at: Date;
}

const COLUMNS = `review_id, tenant_id, user_id, status, va_attempt_id, notice_version,
  dispute_of_review_id, front_key, back_key, selfie_key, read_result, identity_match,
  licence_fingerprint, licence_fingerprint_key_id, conflicting_review_id, failure_class,
  decline_reason, revoke_reason, approved_by, approved_at, confirmed_by, confirmed_at,
  declined_by, revoked_by, revoked_at, read_at, decided_at, created_at`;

const opt = <T>(value: T | null): T | undefined => value ?? undefined;

function toReview(row: ReviewRow): LicenceReview {
  return {
    reviewId: row.review_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    status: row.status,
    vaAttemptId: row.va_attempt_id,
    noticeVersion: row.notice_version,
    disputeOfReviewId: opt(row.dispute_of_review_id),
    images: {
      front: row.front_key !== null,
      back: row.back_key !== null,
      selfie: row.selfie_key !== null,
    },
    reading: opt(row.read_result),
    identityMatch: opt(row.identity_match),
    fingerprint:
      row.licence_fingerprint !== null && row.licence_fingerprint_key_id !== null
        ? { hash: row.licence_fingerprint, keyId: row.licence_fingerprint_key_id }
        : undefined,
    conflictingReviewId: opt(row.conflicting_review_id),
    failureClass: opt(row.failure_class),
    declineReason: opt(row.decline_reason),
    revokeReason: opt(row.revoke_reason),
    approvedBy: opt(row.approved_by),
    approvedAt: opt(row.approved_at),
    confirmedBy: opt(row.confirmed_by),
    confirmedAt: opt(row.confirmed_at),
    declinedBy: opt(row.declined_by),
    revokedBy: opt(row.revoked_by),
    revokedAt: opt(row.revoked_at),
    readAt: opt(row.read_at),
    decidedAt: opt(row.decided_at),
    submittedAt: row.created_at,
  };
}

const first = (rows: ReviewRow[]) => (rows[0] === undefined ? undefined : toReview(rows[0]));

export async function insertReview(
  tx: Queryable,
  input: {
    reviewId: string;
    tenantId: string;
    userId: string;
    vaAttemptId: string;
    noticeVersion: string;
    disputeOfReviewId: string | undefined;
    keys: Readonly<Record<LicenceImageSide, string>>;
  },
): Promise<LicenceReview> {
  const result = await tx.query<ReviewRow>(
    `INSERT INTO veteran_licence_reviews
       (review_id, tenant_id, user_id, status, va_attempt_id, notice_version,
        dispute_of_review_id, front_key, back_key, selfie_key)
     VALUES ($1, $2, $3, 'READING', $4, $5, $6, $7, $8, $9)
     RETURNING ${COLUMNS}`,
    [
      input.reviewId,
      input.tenantId,
      input.userId,
      input.vaAttemptId,
      input.noticeVersion,
      input.disputeOfReviewId ?? null,
      input.keys.front,
      input.keys.back,
      input.keys.selfie,
    ],
  );
  const review = first(result.rows);
  if (review === undefined) throw new Error('Licence review was not recorded.');
  return review;
}

export async function findReview(
  db: Queryable,
  tenantId: string,
  reviewId: string,
  options: { forUpdate?: boolean } = {},
): Promise<LicenceReview | undefined> {
  const result = await db.query<ReviewRow>(
    `SELECT ${COLUMNS} FROM veteran_licence_reviews WHERE tenant_id = $1 AND review_id = $2
     ${options.forUpdate === true ? 'FOR UPDATE' : ''}`,
    [tenantId, reviewId],
  );
  return first(result.rows);
}

export async function findNewestReview(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<LicenceReview | undefined> {
  const result = await db.query<ReviewRow>(
    `SELECT ${COLUMNS} FROM veteran_licence_reviews WHERE tenant_id = $1 AND user_id = $2
      ORDER BY created_at DESC, review_id DESC LIMIT 1`,
    [tenantId, userId],
  );
  return first(result.rows);
}

export async function findOpenReview(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<LicenceReview | undefined> {
  const result = await db.query<ReviewRow>(
    `SELECT ${COLUMNS} FROM veteran_licence_reviews
      WHERE tenant_id = $1 AND user_id = $2 AND status = ANY($3::text[])`,
    [tenantId, userId, OPEN_STATUSES],
  );
  return first(result.rows);
}

/**
 * L8.1: submissions the reader answered (`read_at` is set on a reading and on
 * NOT_A_LICENCE) in the last `hours`, and the seconds until the oldest leaves the window.
 */
export async function countAnsweredSubmissions(
  db: Queryable,
  tenantId: string,
  userId: string,
  hours: number,
): Promise<{ count: number; retryAfterSeconds: number | undefined }> {
  const result = await db.query<{ count: number; retry: number | null }>(
    `SELECT count(*)::int AS count,
            ceil(extract(epoch FROM min(created_at) + make_interval(hours => $3) - now()))::int
              AS retry
       FROM veteran_licence_reviews
      WHERE tenant_id = $1 AND user_id = $2 AND read_at IS NOT NULL
        AND created_at > now() - make_interval(hours => $3)`,
    [tenantId, userId, hours],
  );
  const row = result.rows[0];
  return { count: row?.count ?? 0, retryAfterSeconds: row?.retry ?? undefined };
}

/** The VA attempt's stored identity hash and key id, or undefined once released. */
export async function readAttemptIdentity(
  db: Queryable,
  verificationId: string,
): Promise<KeyedHash | undefined> {
  const result = await db.query<{ identity_hash: string | null; identity_key_id: string | null }>(
    `SELECT identity_hash, identity_key_id FROM veteran_verifications WHERE verification_id = $1`,
    [verificationId],
  );
  const row = result.rows[0];
  if (row === undefined || row.identity_hash === null || row.identity_key_id === null) {
    return undefined;
  }
  return { hash: row.identity_hash, keyId: row.identity_key_id };
}

/** An APPROVED review in the tenant holding any of these hashes, other than `exceptId`. */
export async function findApprovedHolder(
  db: Queryable,
  tenantId: string,
  candidates: readonly KeyedHash[],
  exceptId: string,
): Promise<string | undefined> {
  const result = await db.query<{ review_id: string }>(
    `SELECT review_id FROM veteran_licence_reviews
      WHERE tenant_id = $1 AND status = 'APPROVED' AND review_id <> $4
        AND (licence_fingerprint, licence_fingerprint_key_id)
            IN (SELECT * FROM unnest($2::text[], $3::text[]))
      ORDER BY created_at LIMIT 1`,
    [tenantId, candidates.map((c) => c.hash), candidates.map((c) => c.keyId), exceptId],
  );
  return result.rows[0]?.review_id;
}

/** READING to AWAITING_REVIEW with the shown reading and SUAS's two results. */
export async function markRead(
  tx: Queryable,
  input: {
    reviewId: string;
    reading: LicenceReading;
    identityMatch: IdentityMatch;
    fingerprint: KeyedHash | undefined;
    conflictingReviewId: string | undefined;
  },
): Promise<void> {
  await tx.query(
    `UPDATE veteran_licence_reviews
        SET status = 'AWAITING_REVIEW', read_result = $2::jsonb, identity_match = $3,
            licence_fingerprint = $4, licence_fingerprint_key_id = $5,
            conflicting_review_id = $6, read_at = now(), updated_at = now()
      WHERE review_id = $1 AND status = 'READING'`,
    [
      input.reviewId,
      JSON.stringify(input.reading),
      input.identityMatch,
      input.fingerprint?.hash ?? null,
      input.fingerprint?.keyId ?? null,
      input.conflictingReviewId ?? null,
    ],
  );
}

/**
 * An open review to UNREADABLE with its images and reading cleared. `answered` sets
 * `read_at`, so the submission counts (only NOT_A_LICENCE, L8.1).
 */
export async function markUnreadable(
  tx: Queryable,
  input: { reviewId: string; failureClass: LicenceFailureClass; answered: boolean },
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE veteran_licence_reviews
        SET status = 'UNREADABLE', failure_class = $2,
            read_at = CASE WHEN $3 THEN now() ELSE read_at END, decided_at = now(),
            front_key = NULL, back_key = NULL, selfie_key = NULL, read_result = NULL,
            licence_fingerprint = NULL, licence_fingerprint_key_id = NULL, updated_at = now()
      WHERE review_id = $1 AND status = ANY($4::text[])`,
    [input.reviewId, input.failureClass, input.answered, OPEN_STATUSES],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Open reviews submitted more than `days` ago, oldest first (the PHOTOS_EXPIRED sweep). */
export async function listExpiringReviews(
  db: Queryable,
  days: number,
  limit: number,
): Promise<{ tenantId: string; reviewId: string }[]> {
  const result = await db.query<{ tenant_id: string; review_id: string }>(
    `SELECT tenant_id, review_id FROM veteran_licence_reviews
      WHERE status = ANY($1::text[]) AND created_at < now() - make_interval(days => $2)
      ORDER BY created_at LIMIT $3`,
    [OPEN_STATUSES, days, limit],
  );
  return result.rows.map((row) => ({ tenantId: row.tenant_id, reviewId: row.review_id }));
}
