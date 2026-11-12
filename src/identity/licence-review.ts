/**
 * Licence review, the Veteran's side and the read job (suas-specs R10.1, proposal; L1–L4,
 * L7.3, L8, §2.3). The admin decisions live in licence-review-admin.ts.
 *
 * Photos, the selfie and the reading live only while a review is open. Only the reader's
 * answers count toward the limits. Audit payloads hold ids, states and codes, never a
 * field value; the licence number and birth date never leave the read job's memory.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Queryable } from '../db/transaction.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../events/store.js';
import type { DurableJobQueuePort } from '../jobs/port.js';
import type { ObjectStoragePort } from '../storage/object-storage.js';
import type { FingerprintKeyring } from './fingerprint-keys.js';
import { hasSyntheticMarker } from './licence-barcode.js';
import {
  acquireReaderCall,
  isReaderPathOpen,
  recordReaderAnswer,
  recordReaderUnavailable,
} from './licence-breaker.js';
import { identityMatch, licenceFingerprints } from './licence-checks.js';
import {
  deleteLicenceImages,
  getLicenceImage,
  hardenLicenceImage,
  LICENCE_IMAGE_SIDES,
  licenceImageKey,
  LicenceImageRejectedError,
  putLicenceImages,
  type LicenceImageSet,
  type LicenceImageSide,
} from './licence-images.js';
import type {
  LicenceFailureClass,
  LicenceReaderPort,
  LicenceReadResult,
} from './licence-reader.js';
import {
  countAnsweredSubmissions,
  findApprovedHolder,
  findOpenReview,
  findReview,
  insertReview,
  listExpiringReviews,
  markRead,
  markUnreadable,
  readAttemptIdentity,
  type LicenceReview,
} from './licence-review-store.js';
import {
  isAtVaAttemptLimit,
  readNewestVaAttempt,
  readVeteranConfirmation,
  VeteranConfirmationRevokedError,
} from './va-confirmation-store.js';
import { VeteranConfirmationUnavailableError } from './va-confirmation.js';

/** L2.1: the versioned notice the submit body must carry. */
export const LICENCE_NOTICE_V1 = 'licence-notice-v1';
/** L8.3: reader-answered submissions per rolling 24 hours. */
export const LICENCE_MAX_SUBMISSIONS = 3;
/** L8.4: the absolute cap, counted the same way and over the same window (owner question 9). */
export const LICENCE_MAX_TOTAL_SUBMISSIONS = 10;
const SUBMISSION_WINDOW_HOURS = 24;
export const LICENCE_READ_JOB_TYPE = 'licence.read';
/** Queued by migration 0023's triggers when a revocation or deletion closes a review. */
export const LICENCE_CLOSE_JOB_TYPE = 'licence.close';
/** L4.5: one call and at most 3 retries, each retry on a later worker pass. */
export const LICENCE_READ_MAX_ATTEMPTS = 4;
/**
 * §2.3: an open review settles PHOTOS_EXPIRED a day before the 30-day storage lifecycle
 * rule can remove its images, so the review never outlives them.
 */
export const LICENCE_PHOTOS_EXPIRE_DAYS = 29;
const SWEEP_BATCH = 50;

/** The three VA answers after which the licence path is offered (L1.1). */
const OFFERING_REASONS = new Set(['PERSON_NOT_FOUND', 'NOT_TITLE_38', 'MORE_RESEARCH_REQUIRED']);

export class LicenceReviewNotOfferedError extends Error {
  readonly code = 'LICENCE_REVIEW_NOT_OFFERED';
  readonly httpStatus = 403;
  constructor() {
    super('Licence review is offered only after VA answers that it cannot confirm you.');
    this.name = 'LicenceReviewNotOfferedError';
  }
}

export class LicenceNoticeVersionRequiredError extends Error {
  readonly code = 'LICENCE_NOTICE_VERSION_REQUIRED';
  readonly httpStatus = 400;
  constructor() {
    super(`Read the current licence notice (${LICENCE_NOTICE_V1}) before sending photos.`);
    this.name = 'LicenceNoticeVersionRequiredError';
  }
}

export class LicenceReviewOpenError extends Error {
  readonly code = 'LICENCE_REVIEW_OPEN';
  readonly httpStatus = 409;
  constructor() {
    super('A licence review is already in progress.');
    this.name = 'LicenceReviewOpenError';
  }
}

export class LicenceSubmissionLimitError extends Error {
  readonly code = 'LICENCE_SUBMISSION_LIMIT';
  readonly httpStatus = 429;
  constructor(
    readonly retryAfterSeconds: number,
    limit: number,
  ) {
    super(`At most ${limit} licence submissions can be read in the last 24 hours.`);
    this.name = 'LicenceSubmissionLimitError';
  }
}

export class LicenceReviewNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;
  constructor() {
    super('Resource not found.');
    this.name = 'LicenceReviewNotFoundError';
  }
}

export class LicenceReviewNotDisputableError extends Error {
  readonly code = 'LICENCE_REVIEW_NOT_DISPUTABLE';
  readonly httpStatus = 409;
  constructor() {
    super('Only a review declined because the licence is already in use can be disputed.');
    this.name = 'LicenceReviewNotDisputableError';
  }
}

/** 400 naming only the image fields that failed, so no content is echoed. */
export class LicenceImageInputError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;
  constructor(fields: readonly string[]) {
    super(`Check these fields: ${fields.join(', ')}.`);
    this.name = 'LicenceImageInputError';
  }
}

interface Actor {
  readonly type: 'USER' | 'SUAS_ADMIN' | 'SYSTEM';
  readonly id: string;
}
export const SYSTEM_ACTOR: Actor = { type: 'SYSTEM', id: 'licence-review' };

export function auditLicenceReview(
  tx: Queryable,
  review: Pick<LicenceReview, 'reviewId' | 'tenantId' | 'userId'>,
  event: { type: string; action: string; actor: Actor; correlationId?: string | undefined },
  payload: Record<string, string | null>,
) {
  return appendAuditEvent(tx, {
    eventType: event.type,
    action: event.action,
    targetType: 'LicenceReview',
    targetId: review.reviewId,
    aggregateType: 'User',
    aggregateId: review.userId,
    tenantId: review.tenantId,
    actorType: event.actor.type,
    actorId: event.actor.id,
    payload,
    ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
  });
}

/** Serializes one person's licence submissions; held only inside short transactions. */
const lockPerson = (tx: Queryable, tenantId: string, userId: string) =>
  tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`licence-review:${tenantId}:${userId}`]);

/** L1.3–L1.4 and L4.6: the reader is configured and its breaker is not open. */
export async function isLicencePathOpen(db: Queryable, readerConfigured: boolean) {
  return readerConfigured && (await isReaderPathOpen(db));
}

/**
 * L1.3–L1.4, apart from the reader being open: the VA attempt a new review binds to, or
 * undefined when the path is not offered. Offered only when the gate is closed, the
 * standing is not REVOKED, the newest VA-answered attempt is a real NOT_CONFIRMED (never
 * after UNAVAILABLE, so never after a VA 400), and the VA try limit is not reached.
 */
export async function licenceEligibility(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<{ vaAttemptId: string } | undefined> {
  const standing = await readVeteranConfirmation(db, tenantId, userId);
  if (standing?.status === 'REVOKED' || standing?.status === 'VERIFIED') return undefined;
  const attempt = await readNewestVaAttempt(db, tenantId, userId);
  if (attempt?.status !== 'NOT_CONFIRMED' || !OFFERING_REASONS.has(attempt.reason ?? '')) {
    return undefined;
  }
  if (await isAtVaAttemptLimit(db, tenantId, userId)) return undefined;
  return { vaAttemptId: attempt.verificationId };
}

/** Whether this declined review may be disputed now (L7.3), for the Veteran's view. */
export function isDisputable(review: LicenceReview): boolean {
  return review.status === 'DECLINED' && review.declineReason === 'ALREADY_USED';
}

export interface SubmitLicenceDeps {
  readonly pool: Pool;
  readonly storage: ObjectStoragePort;
  readonly jobQueue: DurableJobQueuePort;
  readonly readerConfigured: boolean;
}

export interface SubmitLicenceInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly noticeVersion: unknown;
  /** Parses the uploaded images; run only after every earlier check passed (L2.3). */
  readonly images: () => LicenceImageSet;
  /** L7.3: a dispute of this ALREADY_USED decline, instead of the L1.4 offer. */
  readonly disputeOfReviewId?: string;
  readonly correlationId?: string;
}

/** The L2.3 checks in order, after sign-in; returns the VA attempt to bind to. */
async function checkSubmission(
  db: Queryable,
  readerConfigured: boolean,
  input: SubmitLicenceInput,
): Promise<string> {
  const { tenantId, userId } = input;
  if (!(await isLicencePathOpen(db, readerConfigured))) {
    throw new VeteranConfirmationUnavailableError();
  }
  let vaAttemptId: string;
  if (input.disputeOfReviewId === undefined) {
    const eligible = await licenceEligibility(db, tenantId, userId);
    if (eligible === undefined) throw new LicenceReviewNotOfferedError();
    vaAttemptId = eligible.vaAttemptId;
  } else {
    const disputed = await findReview(db, tenantId, input.disputeOfReviewId);
    if (disputed === undefined || disputed.userId !== userId) {
      throw new LicenceReviewNotFoundError();
    }
    if ((await readVeteranConfirmation(db, tenantId, userId))?.status === 'REVOKED') {
      throw new VeteranConfirmationRevokedError();
    }
    if (!isDisputable(disputed)) throw new LicenceReviewNotDisputableError();
    vaAttemptId = disputed.vaAttemptId;
  }
  if (input.noticeVersion !== LICENCE_NOTICE_V1) throw new LicenceNoticeVersionRequiredError();
  if ((await findOpenReview(db, tenantId, userId)) !== undefined) {
    throw new LicenceReviewOpenError();
  }
  const used = await countAnsweredSubmissions(db, tenantId, userId, SUBMISSION_WINDOW_HOURS);
  for (const limit of [LICENCE_MAX_SUBMISSIONS, LICENCE_MAX_TOTAL_SUBMISSIONS]) {
    if (used.count >= limit) {
      throw new LicenceSubmissionLimitError(Math.max(1, used.retryAfterSeconds ?? 1), limit);
    }
  }
  return vaAttemptId;
}

/** L3: each image re-encoded; the error names every field that broke a rule. */
function hardenAll(images: LicenceImageSet): LicenceImageSet {
  const failed: LicenceImageSide[] = [];
  const out: Partial<Record<LicenceImageSide, Uint8Array>> = {};
  for (const side of LICENCE_IMAGE_SIDES) {
    try {
      out[side] = hardenLicenceImage(images[side]);
    } catch (error) {
      if (!(error instanceof LicenceImageRejectedError)) throw error;
      failed.push(side);
    }
  }
  if (failed.length > 0) throw new LicenceImageInputError(failed);
  return out as LicenceImageSet;
}

/**
 * L2.3: check in order, re-encode, store the images, record a READING review bound to the
 * VA attempt and queue the read after commit. The checks run again under the person's
 * lock, so two sends at once make one review. Images stored for a refused send are deleted.
 */
export async function submitLicence(
  deps: SubmitLicenceDeps,
  input: SubmitLicenceInput,
): Promise<LicenceReview> {
  await checkSubmission(deps.pool, deps.readerConfigured, input);
  const images = hardenAll(input.images());
  const reviewId = randomUUID();
  await putLicenceImages(deps.storage, reviewId, images);
  let review: LicenceReview;
  try {
    review = await withTransaction(deps.pool, async (tx) => {
      await lockPerson(tx, input.tenantId, input.userId);
      const vaAttemptId = await checkSubmission(tx, deps.readerConfigured, input);
      const created = await insertReview(tx, {
        reviewId,
        tenantId: input.tenantId,
        userId: input.userId,
        vaAttemptId,
        noticeVersion: LICENCE_NOTICE_V1,
        disputeOfReviewId: input.disputeOfReviewId,
        keys: {
          front: licenceImageKey(reviewId, 'front'),
          back: licenceImageKey(reviewId, 'back'),
          selfie: licenceImageKey(reviewId, 'selfie'),
        },
      });
      const event = { actor: { type: 'USER', id: input.userId } as const };
      await auditLicenceReview(
        tx,
        created,
        { ...event, type: 'LICENCE_REVIEW_SUBMITTED', action: 'SUBMIT_LICENCE_REVIEW' },
        { status: 'READING', notice_version: LICENCE_NOTICE_V1 },
      );
      if (input.disputeOfReviewId !== undefined) {
        await auditLicenceReview(
          tx,
          created,
          {
            ...event,
            type: 'LICENCE_REVIEW_DISPUTED',
            action: 'DISPUTE_LICENCE_REVIEW',
            correlationId: input.correlationId,
          },
          { dispute_of_review_id: input.disputeOfReviewId },
        );
      }
      return created;
    });
  } catch (error) {
    await deleteLicenceImages(deps.storage, reviewId).catch(() => undefined);
    throw error;
  }

  try {
    await deps.jobQueue.enqueue({
      jobType: LICENCE_READ_JOB_TYPE,
      payload: { review_id: reviewId },
      tenantId: input.tenantId,
      idempotencyKey: reviewId,
      maxAttempts: LICENCE_READ_MAX_ATTEMPTS,
    });
  } catch (error) {
    // Without a queued read the review would stay open for good; it settles, not counted.
    await settleUnreadable(deps.pool, deps.storage, review, 'PROVIDER_UNAVAILABLE');
    throw error;
  }
  // An inline queue (LOCAL and TEST) has already read it; report the current state.
  return (await findReview(deps.pool, input.tenantId, reviewId)) ?? review;
}

/**
 * Settles an open review UNREADABLE and deletes its images. Only NOT_A_LICENCE counts.
 * A review closed meanwhile (a revocation or deletion) is left as it is.
 */
async function settleUnreadable(
  pool: Pool,
  storage: ObjectStoragePort | undefined,
  review: Pick<LicenceReview, 'reviewId' | 'tenantId' | 'userId'>,
  failureClass: LicenceFailureClass,
): Promise<void> {
  await withTransaction(pool, async (tx) => {
    const current = await findReview(tx, review.tenantId, review.reviewId, { forUpdate: true });
    if (current === undefined) return;
    if (storage !== undefined) await deleteLicenceImages(storage, review.reviewId);
    const settled = await markUnreadable(tx, {
      reviewId: review.reviewId,
      failureClass,
      answered: failureClass === 'NOT_A_LICENCE',
    });
    if (!settled) return;
    await auditLicenceReview(
      tx,
      current,
      { type: 'LICENCE_REVIEW_READ', action: 'READ_LICENCE_REVIEW', actor: SYSTEM_ACTOR },
      { status: 'UNREADABLE', failure_class: failureClass },
    );
  });
}

export interface LicenceReadDeps {
  readonly pool: Pool;
  readonly storage: ObjectStoragePort | undefined;
  readonly reader: LicenceReaderPort | undefined;
  readonly keyring: FingerprintKeyring | undefined;
  /** L4.2: outside LOCAL and TEST the back must carry `iin` before anything is sent. */
  readonly synthetic: { readonly required: boolean; readonly iin: string | undefined };
}

export interface LicenceReadJob {
  readonly tenantId: string;
  readonly reviewId: string;
  /** This try, from 1; absent for an inline run, which never retries. */
  readonly attempt?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

/**
 * The read job (L4). `retry` asks the queue to run it again on a later pass with backoff
 * after a reader-unavailable answer; the last try settles instead. Storage and database
 * errors throw, so the queue retries those too. A missing image is PHOTOS_GONE.
 */
export async function recordLicenceRead(
  deps: LicenceReadDeps,
  job: LicenceReadJob,
): Promise<'settled' | 'retry' | 'skipped'> {
  const review = await findReview(deps.pool, job.tenantId, job.reviewId);
  if (review?.status !== 'READING') return 'skipped';
  const settle = async (failureClass: LicenceFailureClass) => {
    await settleUnreadable(deps.pool, deps.storage, review, failureClass);
    return 'settled' as const;
  };
  const { reader, storage, keyring } = deps;
  if (reader === undefined || storage === undefined || keyring === undefined) {
    return settle('CONFIGURATION_INVALID');
  }
  const front = await getLicenceImage(storage, review.reviewId, 'front');
  const back = await getLicenceImage(storage, review.reviewId, 'back');
  if (front === undefined || back === undefined) return settle('PHOTOS_GONE');
  if (deps.synthetic.required && !hasSyntheticMarker(back, deps.synthetic.iin)) {
    return settle('NOT_SYNTHETIC');
  }
  const call = await acquireReaderCall(deps.pool);
  if (call === 'open') return settle('PROVIDER_UNAVAILABLE');

  // Only the front and back go to the reader; the selfie is never loaded here.
  const result: LicenceReadResult = await reader.read({ front, back });
  if (result.status === 'UNAVAILABLE') {
    const last = job.attempt === undefined || job.attempt >= (job.maxAttempts ?? 1);
    await recordReaderUnavailable(deps.pool, { probe: call === 'probe', settled: last });
    return last ? settle(result.failureClass) : 'retry';
  }
  await recordReaderAnswer(deps.pool);
  if (result.status === 'NOT_SYNTHETIC') return settle('NOT_SYNTHETIC');
  if (result.status === 'NOT_A_LICENCE') return settle('NOT_A_LICENCE');

  const { reading, secrets } = result;
  const fingerprints = licenceFingerprints(keyring, reading, secrets);
  const attempt = await readAttemptIdentity(deps.pool, review.vaAttemptId);
  const match = identityMatch(keyring, reading, secrets, attempt);
  const holder =
    fingerprints === undefined
      ? undefined
      : await findApprovedHolder(deps.pool, job.tenantId, fingerprints.candidates, review.reviewId);
  await withTransaction(deps.pool, async (tx) => {
    const current = await findReview(tx, job.tenantId, job.reviewId, { forUpdate: true });
    if (current?.status !== 'READING') return;
    await markRead(tx, {
      reviewId: review.reviewId,
      reading,
      identityMatch: match,
      fingerprint: fingerprints?.stored,
      conflictingReviewId: holder,
    });
    await auditLicenceReview(
      tx,
      current,
      { type: 'LICENCE_REVIEW_READ', action: 'READ_LICENCE_REVIEW', actor: SYSTEM_ACTOR },
      { status: 'AWAITING_REVIEW', identity_match: match },
    );
  });
  return 'settled';
}

/**
 * Finishes a review that migration 0023 closed as DECLINED / OTHER because the person's
 * standing became REVOKED or the account was deleted (L7.5, L8.6): deletes the images
 * and writes the Audit Event the database trigger cannot.
 */
export async function finishClosedReview(
  deps: { readonly pool: Pool; readonly storage: ObjectStoragePort | undefined },
  job: { readonly tenantId: string; readonly reviewId: string; readonly cause: string },
): Promise<void> {
  const review = await findReview(deps.pool, job.tenantId, job.reviewId);
  if (review === undefined) return;
  if (deps.storage !== undefined) await deleteLicenceImages(deps.storage, review.reviewId);
  await auditLicenceReview(
    deps.pool,
    review,
    { type: 'LICENCE_REVIEW_DECIDED', action: 'DECIDE_LICENCE_REVIEW', actor: SYSTEM_ACTOR },
    { outcome: 'DECLINED', decline_reason: 'OTHER', cause: job.cause },
  );
}

/** §2.3 backstop: open reviews near the storage lifecycle age settle PHOTOS_EXPIRED. */
export async function expireOldReviews(deps: {
  readonly pool: Pool;
  readonly storage: ObjectStoragePort | undefined;
}): Promise<number> {
  const due = await listExpiringReviews(deps.pool, LICENCE_PHOTOS_EXPIRE_DAYS, SWEEP_BATCH);
  for (const item of due) {
    const review = await findReview(deps.pool, item.tenantId, item.reviewId);
    if (review !== undefined)
      await settleUnreadable(deps.pool, deps.storage, review, 'PHOTOS_EXPIRED');
  }
  return due.length;
}
