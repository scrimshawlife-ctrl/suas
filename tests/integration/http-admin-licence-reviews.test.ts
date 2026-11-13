/**
 * The SUAS Admin licence review routes (suas-specs R10.1, proposal; L5, L7.1–L7.3): MFA
 * admins only, no self-review, two different admins to approve, the approval refusals,
 * decline, recuse, revoke (FRAUD and REVIEW_ERROR), and dispute routing. Fixture VA and
 * licence reader; the read runs inline. Synthetic data only. Requires PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession, elevateSession } from '../../src/auth/index.js';
import {
  createUser,
  grantSuasAdmin,
  setUserDisplayName,
  VA_NOTICE_V1,
} from '../../src/identity/index.js';
import { LICENCE_FIXTURE_WIDTHS } from '../../src/identity/licence-reader-fixture.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { licenceSubmission } from '../helpers/licence.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_VA_CONFIRMATION_MODE: 'fixture',
      SUAS_LICENCE_READER_MODE: 'fixture',
      SUAS_OBJECT_STORAGE_MODE: 'fake',
    }),
    listen: false,
  });
  await db().query(`UPDATE licence_reader_breaker SET consecutive_failures = 0, opened_at = NULL`);
});

afterAll(async () => {
  await app.close();
});

const db = () => {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
};
const BASE = '/api/v0/admin/licence-reviews';
const APPROVAL = {
  designation_visible: true,
  checklist: { selfie_matches: true, security_features: true, whole_card: true },
};
type Headers = Record<string, string>;

async function signIn(tenantId: string, options: { admin?: boolean; elevate?: boolean } = {}) {
  const user = await createUser(db(), {
    tenantId,
    email: syntheticEmail(`adm-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await setUserDisplayName(db(), tenantId, user.userId, 'Synthetic V.');
  if (options.admin === true) await grantSuasAdmin(db(), user.userId, undefined);
  const session = await createSession(db(), TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  if (options.elevate !== false && options.admin === true) {
    await elevateSession(db(), session.session.sessionId);
  }
  return { userId: user.userId, headers: { authorization: `Bearer ${session.credential}` } };
}
const admin = (tenantId: string) => signIn(tenantId, { admin: true });

/** A Veteran VA did not confirm, with a licence review already read (inline). */
async function submitted(
  tenantId: string,
  frontWidth?: number,
  person?: Awaited<ReturnType<typeof signIn>>,
) {
  const who = person ?? (await signIn(tenantId));
  await app.server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/va/confirm',
    headers: { ...who.headers, 'idempotency-key': randomUUID() },
    payload: {
      firstName: 'Synthetic',
      lastName: 'Veteran',
      birthDate: '1970-01-02',
      streetAddressLine1: '1 Example Way',
      city: 'Exampleton',
      state: 'CA',
      zipCode: '00002',
      noticeVersion: VA_NOTICE_V1,
    },
  });
  const sent = await app.server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/licence',
    headers: who.headers,
    payload: licenceSubmission(frontWidth === undefined ? {} : { frontWidth }),
  });
  expect(sent.statusCode).toBe(202);
  return { ...who, reviewId: sent.json<{ review_id: string }>().review_id };
}

const get = (headers: Headers, url: string) => app.server.inject({ method: 'GET', url, headers });
const run = (
  headers: Headers,
  reviewId: string,
  name: string,
  payload: object,
  key = randomUUID(),
) =>
  app.server.inject({
    method: 'POST',
    url: `${BASE}/${reviewId}/commands/${name}`,
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });
const code = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;
const standing = async (headers: Headers) =>
  (await get(headers, '/api/v0/veterans/me')).json<{
    id_verification: { method: string; status: string };
  }>().id_verification;
const queueIds = async (headers: Headers) =>
  (await get(headers, BASE))
    .json<{ reviews: { review_id: string }[] }>()
    .reviews.map((r) => r.review_id);

describe('admin licence review access', () => {
  it('needs an MFA-elevated SUAS Admin and never shows an admin their own review', async () => {
    const tenantId = randomUUID();
    const veteran = await signIn(tenantId);
    const unelevated = await signIn(tenantId, { admin: true, elevate: false });
    expect((await get(veteran.headers, BASE)).statusCode).toBe(403);
    expect((await get(unelevated.headers, BASE)).statusCode).toBe(403);

    const subject = await signIn(tenantId, { admin: true });
    const own = await submitted(tenantId, undefined, subject);
    expect(await queueIds(subject.headers)).not.toContain(own.reviewId);
    const direct = await get(subject.headers, `${BASE}/${own.reviewId}`);
    expect(direct.statusCode).toBe(403);
    expect(code(direct)).toBe('SELF_REVIEW_FORBIDDEN');
    expect(code(await run(subject.headers, own.reviewId, 'approve', APPROVAL))).toBe(
      'SELF_REVIEW_FORBIDDEN',
    );
    expect(await queueIds((await admin(tenantId)).headers)).toEqual([own.reviewId]);
  });

  it('serves images inline, never cached, and shows no name or number on the page', async () => {
    const tenantId = randomUUID();
    const review = await submitted(tenantId);
    const reviewer = await admin(tenantId);
    const image = await get(reviewer.headers, `${BASE}/${review.reviewId}/images/selfie`);
    expect(image.statusCode).toBe(200);
    expect(image.headers['cache-control']).toBe('no-store, private');
    expect(image.headers['content-type']).toBe('image/jpeg');
    expect(image.headers['content-disposition']).toBe('inline');

    const page = (await get(reviewer.headers, `${BASE}/${review.reviewId}`)).json<
      Record<string, unknown>
    >();
    expect(page).toMatchObject({
      status: 'AWAITING_REVIEW',
      identity_match: 'YES',
      fingerprint_in_use: false,
      images: { front: true, back: true, selfie: true },
      viewer: { can_approve: true, can_confirm: false, can_decline: true, can_revoke: false },
    });
    expect(JSON.stringify(page)).not.toMatch(/F0000001|1970-01-02|Synthetic V\./);
    expect(JSON.stringify(page)).not.toContain(review.userId);
  });
});

describe('two-admin approval (L5.4, L5.5)', () => {
  it('needs a second, different admin; only the confirmation opens the gate', async () => {
    const tenantId = randomUUID();
    const veteran = await submitted(tenantId);
    const first = await admin(tenantId);
    const second = await admin(tenantId);

    expect(
      (
        await run(first.headers, veteran.reviewId, 'approve', {
          ...APPROVAL,
          designation_visible: false,
        })
      ).statusCode,
    ).toBe(400);
    const approveKey = randomUUID();
    const approved = await run(first.headers, veteran.reviewId, 'approve', APPROVAL, approveKey);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'AWAITING_CONFIRMATION',
      approved_by: first.userId,
    });
    expect((await standing(veteran.headers)).status).not.toBe('VERIFIED');
    // A replay with the same key answers again without a second decision.
    expect(
      (await run(first.headers, veteran.reviewId, 'approve', APPROVAL, approveKey)).statusCode,
    ).toBe(200);
    expect(code(await run(first.headers, veteran.reviewId, 'approve', APPROVAL))).toBe(
      'LICENCE_REVIEW_NOT_READY',
    );

    const self = await run(first.headers, veteran.reviewId, 'confirm', APPROVAL);
    expect(self.statusCode).toBe(403);
    expect(code(self)).toBe('SECOND_REVIEWER_REQUIRED');

    const confirmed = await run(second.headers, veteran.reviewId, 'confirm', APPROVAL);
    expect(confirmed.json()).toMatchObject({
      status: 'APPROVED',
      confirmed_by: second.userId,
      reading: null,
      images: { front: false, back: false, selfie: false },
    });
    expect(await standing(veteran.headers)).toMatchObject({
      method: 'MANUAL_REVIEW',
      status: 'VERIFIED',
    });
    expect((await get(second.headers, `${BASE}/${veteran.reviewId}/images/front`)).statusCode).toBe(
      404,
    );
    expect(code(await run(second.headers, veteran.reviewId, 'decline', { reason: 'OTHER' }))).toBe(
      'LICENCE_REVIEW_DECIDED',
    );

    const events = await db().query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM audit_events WHERE target_id = $1 ORDER BY occurred_at`,
      [veteran.reviewId],
    );
    expect(events.rows.map((row) => row.event_type)).toEqual([
      'LICENCE_REVIEW_SUBMITTED',
      'LICENCE_REVIEW_READ',
      'LICENCE_REVIEW_DECIDED',
      'LICENCE_REVIEW_CONFIRMED',
    ]);
    expect(events.rows[2]?.payload).toEqual({ outcome: 'APPROVAL_PROPOSED', decline_reason: null });
  });

  it('refuses approval without YES identity or a fingerprint, but allows a decline', async () => {
    const tenantId = randomUUID();
    const reviewer = await admin(tenantId);
    const mismatch = await submitted(tenantId, LICENCE_FIXTURE_WIDTHS.OTHER_IDENTITY);
    expect(code(await run(reviewer.headers, mismatch.reviewId, 'approve', APPROVAL))).toBe(
      'LICENCE_IDENTITY_MISMATCH',
    );
    const unnumbered = await submitted(tenantId, LICENCE_FIXTURE_WIDTHS.NUMBER_NOT_READ);
    expect((await get(reviewer.headers, `${BASE}/${unnumbered.reviewId}`)).json()).toMatchObject({
      fingerprint_in_use: null,
    });
    expect(code(await run(reviewer.headers, unnumbered.reviewId, 'approve', APPROVAL))).toBe(
      'LICENCE_FINGERPRINT_MISSING',
    );
    const declined = await run(reviewer.headers, mismatch.reviewId, 'decline', {
      reason: 'IDENTITY_MISMATCH',
    });
    expect(declined.json()).toMatchObject({
      status: 'DECLINED',
      decline_reason: 'IDENTITY_MISMATCH',
      images: { front: false, back: false, selfie: false },
    });
  });

  it('hides a review from an admin who recused, and refuses their commands', async () => {
    const tenantId = randomUUID();
    const review = await submitted(tenantId);
    const reviewer = await admin(tenantId);
    expect((await run(reviewer.headers, review.reviewId, 'recuse', {})).statusCode).toBe(204);
    expect((await run(reviewer.headers, review.reviewId, 'recuse', {})).statusCode).toBe(204);
    expect(await queueIds(reviewer.headers)).toEqual([]);
    expect(code(await get(reviewer.headers, `${BASE}/${review.reviewId}`))).toBe(
      'REVIEWER_RECUSED',
    );
    expect(code(await run(reviewer.headers, review.reviewId, 'decline', { reason: 'OTHER' }))).toBe(
      'REVIEWER_RECUSED',
    );
  });
});

describe('already used, dispute and revoke (L7)', () => {
  async function approve(reviewId: string, first: Headers, second: Headers) {
    await run(first, reviewId, 'approve', APPROVAL);
    const confirmed = await run(second, reviewId, 'confirm', APPROVAL);
    expect(confirmed.json()).toMatchObject({ status: 'APPROVED' });
  }

  it('routes a dispute away from the earlier approvers, and REVIEW_ERROR frees the licence', async () => {
    const tenantId = randomUUID();
    const [a, b, c, d] = await Promise.all([
      admin(tenantId),
      admin(tenantId),
      admin(tenantId),
      admin(tenantId),
    ]);
    const holder = await submitted(tenantId);
    await approve(holder.reviewId, a.headers, b.headers);

    const claimant = await submitted(tenantId);
    expect((await get(c.headers, `${BASE}/${claimant.reviewId}`)).json()).toMatchObject({
      fingerprint_in_use: true,
      conflicting_review: {
        review_id: holder.reviewId,
        approved_by: a.userId,
        confirmed_by: b.userId,
      },
    });
    expect(code(await run(c.headers, claimant.reviewId, 'approve', APPROVAL))).toBe(
      'LICENCE_ALREADY_USED',
    );
    await run(c.headers, claimant.reviewId, 'decline', { reason: 'ALREADY_USED' });

    const disputed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/veterans/me/verification/licence/${claimant.reviewId}/commands/dispute`,
      headers: claimant.headers,
      payload: licenceSubmission(),
    });
    expect(disputed.statusCode).toBe(202);
    const disputeId = disputed.json<{ review_id: string }>().review_id;
    expect(await queueIds(a.headers)).not.toContain(disputeId);
    expect(await queueIds(b.headers)).not.toContain(disputeId);
    expect(await queueIds(c.headers)).toContain(disputeId);
    expect(code(await get(a.headers, `${BASE}/${disputeId}`))).toBe('REVIEWER_RECUSED');

    const revoked = await run(c.headers, holder.reviewId, 'revoke', { reason: 'REVIEW_ERROR' });
    expect(revoked.json()).toMatchObject({ status: 'REVOKED', revoke_reason: 'REVIEW_ERROR' });
    // The approval stops opening the gate, but the holder is not barred.
    expect((await standing(holder.headers)).status).not.toBe('VERIFIED');
    const attest = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/commands/self-attest',
      headers: { ...holder.headers, 'idempotency-key': randomUUID() },
    });
    expect(attest.statusCode).toBe(200);

    expect((await get(c.headers, `${BASE}/${disputeId}`)).json()).toMatchObject({
      fingerprint_in_use: false,
    });
    await approve(disputeId, c.headers, d.headers);
    expect(await standing(claimant.headers)).toMatchObject({
      method: 'MANUAL_REVIEW',
      status: 'VERIFIED',
    });
  });

  it('FRAUD writes REVOKED, which blocks self-attestation', async () => {
    const tenantId = randomUUID();
    const [a, b] = await Promise.all([admin(tenantId), admin(tenantId)]);
    const veteran = await submitted(tenantId);
    await approve(veteran.reviewId, a.headers, b.headers);
    expect(code(await run(a.headers, veteran.reviewId, 'revoke', { reason: 'SOMETHING' }))).toBe(
      'VALIDATION_FAILED',
    );
    const revoked = await run(a.headers, veteran.reviewId, 'revoke', { reason: 'FRAUD' });
    expect(revoked.json()).toMatchObject({
      status: 'REVOKED',
      revoke_reason: 'FRAUD',
      revoked_by: a.userId,
    });
    expect((await standing(veteran.headers)).status).toBe('REVOKED');
    const attest = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/commands/self-attest',
      headers: { ...veteran.headers, 'idempotency-key': randomUUID() },
    });
    expect(code(attest)).toBe('VERIFICATION_REVOKED');
    expect(code(await run(b.headers, veteran.reviewId, 'revoke', { reason: 'FRAUD' }))).toBe(
      'LICENCE_REVIEW_DECIDED',
    );
  });
});
