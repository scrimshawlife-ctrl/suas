/**
 * Licence review, the Veteran's side and the read job (suas-specs R10.1, proposal; L1–L4,
 * L7.3, L7.5, L8, §2.3): who is offered the path, the submit checks in order, what the
 * reader may see and what is kept, the limits, retries and breaker, and the closures.
 * Synthetic people, licences and keys only. Requires PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createUser, identityHash, type FingerprintKeyring } from '../../src/identity/index.js';
import {
  LICENCE_FIXTURE_IDENTITY,
  LICENCE_FIXTURE_WIDTHS,
  FixtureLicenceReader,
} from '../../src/identity/licence-reader-fixture.js';
import type {
  LicenceImages,
  LicenceReaderPort,
  LicenceReadResult,
} from '../../src/identity/licence-reader.js';
import {
  expireOldReviews,
  finishClosedReview,
  isLicencePathOpen,
  licenceEligibility,
  LICENCE_NOTICE_V1,
  LICENCE_READ_JOB_TYPE,
  LICENCE_READ_MAX_ATTEMPTS,
  LicenceImageInputError,
  LicenceNoticeVersionRequiredError,
  LicenceReviewNotDisputableError,
  LicenceReviewNotOfferedError,
  LicenceReviewOpenError,
  LicenceSubmissionLimitError,
  recordLicenceRead,
  submitLicence,
  type SubmitLicenceInput,
} from '../../src/identity/licence-review.js';
import { findReview } from '../../src/identity/licence-review-store.js';
import { hasConfirmedVeteranStatus } from '../../src/identity/va-confirmation-store.js';
import { VeteranConfirmationUnavailableError } from '../../src/identity/va-confirmation.js';
import type { DurableJobQueuePort, JobEnqueueRequest } from '../../src/jobs/port.js';
import { PostgresOutboxJobQueue } from '../../src/jobs/postgres-outbox-queue.js';
import { runJobWorker } from '../../src/jobs/worker.js';
import { InMemoryObjectStorage } from '../../src/storage/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { TEST_FINGERPRINT_KEY, TEST_FINGERPRINT_KEY_ID, validEnv } from '../helpers/env.js';
import { licenceFixture, testJpeg } from '../helpers/licence.js';

const pool: Pool = createTestPool();
const KEYRING: FingerprintKeyring = {
  current: { id: TEST_FINGERPRINT_KEY_ID, secret: TEST_FINGERPRINT_KEY },
};
let tenantId: string;
let storage: InMemoryObjectStorage;
let queued: JobEnqueueRequest[];
const queue: DurableJobQueuePort = {
  durability: 'non-durable',
  implementation: 'recording',
  enqueue: (request) => {
    queued.push(request);
    return Promise.resolve({ jobId: randomUUID(), jobType: request.jobType, deduplicated: false });
  },
};

beforeEach(async () => {
  await resetKernelTables(pool);
  await pool.query(
    `UPDATE licence_reader_breaker
        SET consecutive_failures = 0, opened_at = NULL, probe_started_at = NULL`,
  );
  tenantId = randomUUID();
  storage = new InMemoryObjectStorage();
  queued = [];
});

afterAll(async () => {
  await pool.end();
});

/** A person whose newest VA attempt is a settled answer, as the fixture would write it. */
async function veteran(
  answer: { status: string; reason?: string | null; failureClass?: string | null } = {
    status: 'NOT_CONFIRMED',
    reason: 'PERSON_NOT_FOUND',
  },
) {
  const user = await createUser(pool, { tenantId, email: syntheticEmail(`lic-${randomUUID()}`) });
  const attemptId = await vaAttempt(user.userId, answer);
  return { userId: user.userId, attemptId };
}

async function vaAttempt(
  userId: string,
  answer: { status: string; reason?: string | null; failureClass?: string | null },
) {
  const attemptId = randomUUID();
  const answered = answer.status === 'NOT_CONFIRMED' || answer.status === 'VERIFIED';
  const identity = answered ? identityHash(KEYRING, LICENCE_FIXTURE_IDENTITY) : undefined;
  await pool.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        not_confirmed_reason, failure_class, settled_at, verified_at, idempotency_key,
        identity_hash, identity_key_id)
     VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', $4::suas_veteran_verification_status, 'SUAS',
             'test', $5::suas_va_not_confirmed_reason, $6, clock_timestamp(),
             CASE WHEN $4 = 'VERIFIED' THEN clock_timestamp() END, $7, $8, $9)`,
    [
      attemptId,
      tenantId,
      userId,
      answer.status,
      answer.reason ?? null,
      answer.failureClass ?? null,
      randomUUID(),
      identity?.hash ?? null,
      identity?.keyId ?? null,
    ],
  );
  return attemptId;
}

const images = (frontWidth = 640) => ({
  front: testJpeg(frontWidth),
  back: licenceFixture('back-synthetic.jpg'),
  selfie: testJpeg(480, 640),
});

const submitDeps = (readerConfigured = true) => ({
  pool,
  storage,
  jobQueue: queue,
  readerConfigured,
});

const submit = (
  userId: string,
  overrides: Partial<SubmitLicenceInput> & { frontWidth?: number } = {},
) =>
  submitLicence(submitDeps(), {
    tenantId,
    userId,
    noticeVersion: LICENCE_NOTICE_V1,
    images: () => images(overrides.frontWidth),
    ...overrides,
  });

/** Records what the reader was given; answers like the fixture unless told otherwise. */
function recordingReader(answer?: LicenceReadResult) {
  const seen: (keyof LicenceImages)[][] = [];
  const fixture = new FixtureLicenceReader();
  const reader: LicenceReaderPort = {
    implementation: 'recording',
    read: (given) => {
      seen.push(Object.keys(given) as (keyof LicenceImages)[]);
      return answer === undefined ? fixture.read(given) : Promise.resolve(answer);
    },
  };
  return { reader, seen };
}

const readDeps = (
  reader: LicenceReaderPort,
  synthetic = { required: false, iin: undefined as string | undefined },
) => ({
  pool,
  storage,
  reader,
  keyring: KEYRING,
  synthetic,
});

const read = (reviewId: string, reader: LicenceReaderPort, attempt?: number) =>
  recordLicenceRead(readDeps(reader), {
    tenantId,
    reviewId,
    attempt,
    maxAttempts: LICENCE_READ_MAX_ATTEMPTS,
  });

const storedKeys = () => [
  ...(storage as unknown as { objects: Map<string, unknown> }).objects.keys(),
];

describe('licence path offer (L1)', () => {
  it('is offered only after a real NOT_CONFIRMED answer, never after UNAVAILABLE', async () => {
    const offered = await veteran();
    expect(await licenceEligibility(pool, tenantId, offered.userId)).toEqual({
      vaAttemptId: offered.attemptId,
    });

    // A VA 400 is UNAVAILABLE / REQUEST_INVALID and closes the path, as do outages.
    for (const failureClass of ['REQUEST_INVALID', 'PROVIDER_UNAVAILABLE', 'TIMEOUT']) {
      const person = await veteran({ status: 'UNAVAILABLE', failureClass });
      expect(await licenceEligibility(pool, tenantId, person.userId)).toBeUndefined();
      await expect(submit(person.userId)).rejects.toBeInstanceOf(LicenceReviewNotOfferedError);
    }
    // A later UNAVAILABLE replaces an earlier NOT_CONFIRMED as the VA standing.
    await vaAttempt(offered.userId, { status: 'UNAVAILABLE', failureClass: 'REQUEST_INVALID' });
    expect(await licenceEligibility(pool, tenantId, offered.userId)).toBeUndefined();
  });

  it('is not offered when VERIFIED, REVOKED, at the VA try limit or with the reader closed', async () => {
    const attested = await veteran();
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          verified_at, settled_at)
       VALUES ($1, $2, $3, 'SELF_ATTESTATION', 'VERIFIED', 'SUAS', 't', now(), now())`,
      [randomUUID(), tenantId, attested.userId],
    );
    expect(await licenceEligibility(pool, tenantId, attested.userId)).toBeUndefined();

    const revoked = await veteran();
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version)
       VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'REVOKED', 'SUAS', 't')`,
      [randomUUID(), tenantId, revoked.userId],
    );
    expect(await licenceEligibility(pool, tenantId, revoked.userId)).toBeUndefined();

    const limited = await veteran();
    for (let i = 0; i < 4; i += 1) {
      await vaAttempt(limited.userId, { status: 'NOT_CONFIRMED', reason: 'NOT_TITLE_38' });
    }
    expect(await licenceEligibility(pool, tenantId, limited.userId)).toBeUndefined();

    const person = await veteran();
    expect(await isLicencePathOpen(pool, false)).toBe(false);
    await expect(
      submitLicence(submitDeps(false), {
        tenantId,
        userId: person.userId,
        noticeVersion: LICENCE_NOTICE_V1,
        images: () => images(),
      }),
    ).rejects.toBeInstanceOf(VeteranConfirmationUnavailableError);
  });
});

describe('submit and read (L2–L4)', () => {
  it('stores three re-encoded images, sends the reader front and back only, and keeps no number', async () => {
    const person = await veteran();
    const review = await submit(person.userId);
    expect(review).toMatchObject({ status: 'READING', vaAttemptId: person.attemptId });
    expect(review.images).toEqual({ front: true, back: true, selfie: true });
    expect(storedKeys().sort()).toEqual(
      ['back', 'front', 'selfie'].map((side) => `licence-reviews/${review.reviewId}/${side}.jpg`),
    );
    expect(queued).toMatchObject([
      { jobType: LICENCE_READ_JOB_TYPE, payload: { review_id: review.reviewId }, maxAttempts: 4 },
    ]);

    const { reader, seen } = recordingReader();
    expect(await read(review.reviewId, reader)).toBe('settled');
    expect(seen).toEqual([['front', 'back']]);
    const after = await findReview(pool, tenantId, review.reviewId);
    expect(after).toMatchObject({ status: 'AWAITING_REVIEW', identityMatch: 'YES' });
    expect(after?.fingerprint?.keyId).toBe(TEST_FINGERPRINT_KEY_ID);
    const row = await pool.query(
      `SELECT read_result::text AS reading FROM veteran_licence_reviews WHERE review_id = $1`,
      [review.reviewId],
    );
    const stored = String(row.rows[0]?.reading);
    expect(stored).not.toContain('F0000001');
    expect(stored).not.toContain(LICENCE_FIXTURE_IDENTITY.birthDate);
    const audit = await pool.query<{ event_type: string; payload: string }>(
      `SELECT event_type, payload::text AS payload FROM audit_events WHERE target_id = $1
        ORDER BY occurred_at`,
      [review.reviewId],
    );
    expect(audit.rows.map((r) => r.event_type)).toEqual([
      'LICENCE_REVIEW_SUBMITTED',
      'LICENCE_REVIEW_READ',
    ]);
    expect(audit.rows.map((r) => r.payload).join()).not.toMatch(/SYNTHETIC|VETERAN|F0000001/);
  });

  it('checks the notice, an open review and then the images, naming only the field', async () => {
    const person = await veteran();
    await expect(
      submit(person.userId, { noticeVersion: 'licence-notice-v0' }),
    ).rejects.toBeInstanceOf(LicenceNoticeVersionRequiredError);
    const tooWide = () => ({ ...images(), selfie: testJpeg(2001, 100) });
    const refused = submit(person.userId, { images: tooWide });
    await expect(refused).rejects.toBeInstanceOf(LicenceImageInputError);
    await expect(refused).rejects.toThrow('Check these fields: selfie.');
    expect(storedKeys()).toEqual([]);

    await submit(person.userId);
    await expect(submit(person.userId)).rejects.toBeInstanceOf(LicenceReviewOpenError);
  });

  it('reads the identity as NO for another name, and as no fingerprint when the number is missing', async () => {
    const person = await veteran();
    const other = await submit(person.userId, {
      frontWidth: LICENCE_FIXTURE_WIDTHS.OTHER_IDENTITY,
    });
    await read(other.reviewId, new FixtureLicenceReader());
    expect(await findReview(pool, tenantId, other.reviewId)).toMatchObject({ identityMatch: 'NO' });

    const second = await veteran();
    const missing = await submit(second.userId, {
      frontWidth: LICENCE_FIXTURE_WIDTHS.NUMBER_NOT_READ,
    });
    await read(missing.reviewId, new FixtureLicenceReader());
    expect((await findReview(pool, tenantId, missing.reviewId))?.fingerprint).toBeUndefined();
  });

  it('outside LOCAL and TEST sends nothing for a back without the synthetic marker', async () => {
    const person = await veteran();
    const review = await submitLicence(submitDeps(), {
      tenantId,
      userId: person.userId,
      noticeVersion: LICENCE_NOTICE_V1,
      images: () => ({ ...images(), back: licenceFixture('back-other-iin.jpg') }),
    });
    const { reader, seen } = recordingReader();
    await recordLicenceRead(readDeps(reader, { required: true, iin: '999999' }), {
      tenantId,
      reviewId: review.reviewId,
    });
    expect(seen).toEqual([]);
    expect(await findReview(pool, tenantId, review.reviewId)).toMatchObject({
      status: 'UNREADABLE',
      failureClass: 'NOT_SYNTHETIC',
    });
    expect(storedKeys()).toEqual([]);
  });
});

describe('limits, retries and missing photos (L4.5–L4.7, L8)', () => {
  it('counts only answered reads: three NOT_A_LICENCE, then 429; outages never count', async () => {
    const person = await veteran();
    for (let i = 0; i < 3; i += 1) {
      const outage = await submit(person.userId, {
        frontWidth: LICENCE_FIXTURE_WIDTHS.READER_UNAVAILABLE,
      });
      await read(outage.reviewId, new FixtureLicenceReader());
      const answered = await submit(person.userId, {
        frontWidth: LICENCE_FIXTURE_WIDTHS.NOT_A_LICENCE,
      });
      await read(answered.reviewId, new FixtureLicenceReader());
    }
    const limited = submit(person.userId);
    await expect(limited).rejects.toBeInstanceOf(LicenceSubmissionLimitError);
    await expect(limited).rejects.toMatchObject({ code: 'LICENCE_SUBMISSION_LIMIT' });
  });

  it('retries a reader outage on later passes, then settles, and the breaker opens after 5', async () => {
    const down = recordingReader({ status: 'UNAVAILABLE', failureClass: 'TIMEOUT' }).reader;
    for (let n = 0; n < 5; n += 1) {
      const person = await veteran();
      const review = await submit(person.userId);
      for (let attempt = 1; attempt < LICENCE_READ_MAX_ATTEMPTS; attempt += 1) {
        expect(await read(review.reviewId, down, attempt)).toBe('retry');
        expect((await findReview(pool, tenantId, review.reviewId))?.status).toBe('READING');
      }
      expect(await isLicencePathOpen(pool, true)).toBe(true);
      expect(await read(review.reviewId, down, LICENCE_READ_MAX_ATTEMPTS)).toBe('settled');
      expect(await findReview(pool, tenantId, review.reviewId)).toMatchObject({
        status: 'UNREADABLE',
        failureClass: 'TIMEOUT',
      });
    }
    expect(await isLicencePathOpen(pool, true)).toBe(false);
    await expect(submit((await veteran()).userId)).rejects.toBeInstanceOf(
      VeteranConfirmationUnavailableError,
    );

    // After 15 minutes the path reopens and one probe goes through; an answer closes it.
    await pool.query(`UPDATE licence_reader_breaker SET opened_at = now() - interval '16 minutes'`);
    expect(await isLicencePathOpen(pool, true)).toBe(true);
    const probe = await submit((await veteran()).userId);
    expect(await read(probe.reviewId, new FixtureLicenceReader())).toBe('settled');
    const breaker = await pool.query(
      `SELECT consecutive_failures, opened_at FROM licence_reader_breaker`,
    );
    expect(breaker.rows[0]).toEqual({ consecutive_failures: 0, opened_at: null });
  });

  it('settles PHOTOS_GONE for a missing image and PHOTOS_EXPIRED near the 30-day backstop', async () => {
    const person = await veteran();
    const gone = await submit(person.userId);
    await storage.delete(`licence-reviews/${gone.reviewId}/back.jpg`);
    await read(gone.reviewId, new FixtureLicenceReader());
    expect(await findReview(pool, tenantId, gone.reviewId)).toMatchObject({
      status: 'UNREADABLE',
      failureClass: 'PHOTOS_GONE',
      readAt: undefined,
    });

    const waiting = await submit(person.userId);
    await read(waiting.reviewId, new FixtureLicenceReader());
    await pool.query(
      `UPDATE veteran_licence_reviews SET created_at = now() - interval '29 days 1 hour'
        WHERE review_id = $1`,
      [waiting.reviewId],
    );
    expect(await expireOldReviews({ pool, storage })).toBe(1);
    expect(await findReview(pool, tenantId, waiting.reviewId)).toMatchObject({
      status: 'UNREADABLE',
      failureClass: 'PHOTOS_EXPIRED',
    });
    expect(storedKeys()).toEqual([]);
  });

  it('reads one licence per worker pass', async () => {
    const config = loadConfig(
      validEnv({ SUAS_LICENCE_READER_MODE: 'fixture', SUAS_OBJECT_STORAGE_MODE: 'fake' }),
    );
    const outbox = new PostgresOutboxJobQueue(pool);
    const ids: string[] = [];
    for (let n = 0; n < 2; n += 1) {
      const person = await veteran();
      const review = await submitLicence(
        { pool, storage, jobQueue: outbox, readerConfigured: true },
        {
          tenantId,
          userId: person.userId,
          noticeVersion: LICENCE_NOTICE_V1,
          images: () => images(),
        },
      );
      ids.push(review.reviewId);
    }
    await runJobWorker({ pool, config, owner: 'test', once: true, limit: 10 });
    const statuses = await Promise.all(
      ids.map(async (id) => (await findReview(pool, tenantId, id))?.status),
    );
    // The worker's own fake storage holds no images, so the one read settles PHOTOS_GONE.
    expect(statuses.filter((status) => status === 'READING')).toHaveLength(1);
  });
});

describe('dispute, revocation and deletion (L7.3, L7.5, L8.6)', () => {
  it('opens a dispute only of an ALREADY_USED decline, bound to the same VA attempt', async () => {
    const person = await veteran();
    const declined = async (reason: string) => {
      const review = await submit(person.userId);
      await pool.query(
        `UPDATE veteran_licence_reviews
            SET status = 'DECLINED', decline_reason = $2, decided_at = now(), front_key = NULL,
                back_key = NULL, selfie_key = NULL
          WHERE review_id = $1`,
        [review.reviewId, reason],
      );
      return review.reviewId;
    };
    const other = await declined('EXPIRED');
    await expect(submit(person.userId, { disputeOfReviewId: other })).rejects.toBeInstanceOf(
      LicenceReviewNotDisputableError,
    );
    const used = await declined('ALREADY_USED');
    // A dispute is open even after the person self-attested, so it skips the L1.4 offer.
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          verified_at, settled_at)
       VALUES ($1, $2, $3, 'SELF_ATTESTATION', 'VERIFIED', 'SUAS', 't', now(), now())`,
      [randomUUID(), tenantId, person.userId],
    );
    const dispute = await submit(person.userId, { disputeOfReviewId: used });
    expect(dispute).toMatchObject({ disputeOfReviewId: used, vaAttemptId: person.attemptId });
  });

  it('closes an open review on a REVOKED standing and finishes it with the images deleted', async () => {
    const person = await veteran();
    const review = await submit(person.userId);
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version)
       VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'REVOKED', 'SUAS', 't')`,
      [randomUUID(), tenantId, person.userId],
    );
    expect(await findReview(pool, tenantId, review.reviewId)).toMatchObject({
      status: 'DECLINED',
      declineReason: 'OTHER',
    });
    await finishClosedReview(
      { pool, storage },
      { tenantId, reviewId: review.reviewId, cause: 'REVOKED' },
    );
    expect(storedKeys()).toEqual([]);
    const audit = await pool.query(
      `SELECT payload FROM audit_events WHERE target_id = $1 AND event_type = 'LICENCE_REVIEW_DECIDED'`,
      [review.reviewId],
    );
    expect(audit.rows[0]?.payload).toEqual({
      outcome: 'DECLINED',
      decline_reason: 'OTHER',
      cause: 'REVOKED',
    });
  });
});

describe('request gate per method (VA_CONFIRMATION_FLOW §1.1)', () => {
  it('lets a newer MANUAL_REVIEW NOT_CONFIRMED row close a manual approval', async () => {
    const person = await veteran();
    const manual = (status: string) =>
      pool.query(
        `INSERT INTO veteran_verifications
           (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
            verified_at, settled_at)
         VALUES ($1, $2, $3, 'MANUAL_REVIEW', $4::suas_veteran_verification_status, 'SUAS', 't',
                 CASE WHEN $4 = 'VERIFIED' THEN clock_timestamp() END, clock_timestamp())`,
        [randomUUID(), tenantId, person.userId, status],
      );
    await manual('VERIFIED');
    expect(await hasConfirmedVeteranStatus(pool, tenantId, person.userId)).toBe(true);
    await manual('NOT_CONFIRMED');
    expect(await hasConfirmedVeteranStatus(pool, tenantId, person.userId)).toBe(false);
    // The person is not barred: self-attestation still opens the gate.
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          verified_at, settled_at)
       VALUES ($1, $2, $3, 'SELF_ATTESTATION', 'VERIFIED', 'SUAS', 't', now(), now())`,
      [randomUUID(), tenantId, person.userId],
    );
    expect(await hasConfirmedVeteranStatus(pool, tenantId, person.userId)).toBe(true);
  });
});
