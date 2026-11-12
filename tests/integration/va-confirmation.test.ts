/**
 * POST /veterans/me/verification/va/confirm, the self-attestation fallback and the gate
 * they open (suas-specs #72 R9.1; D035_VA_CONFIRMATION_ADAPTER.md §9, §11, §12, §13). The
 * fixture adapter answers by ZIP; the privacy test uses the HTTP adapter with a fake
 * transport. Synthetic people and keys only. Requires PostgreSQL.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createServer } from '../../src/http/server.js';
import { CommandInProgressError } from '../../src/idempotency/run.js';
import {
  beginVaAttempt,
  confirmVeteranStatus,
  createUser,
  FixtureVeteranConfirmation,
  setUserDisplayName,
  settleVaAttempt,
  softDeleteUser,
  VA_CONFIRMATION_FINGERPRINT_LABEL,
  VA_CONFIRMATION_FIXTURE_ZIPS,
  VA_CONFIRMATION_MAX_CALLS,
  VA_NOTICE_V1,
  VaIdentityAlreadyVerifiedError,
  VeteranConfirmationRevokedError,
  type AskVa,
  type FingerprintKeyring,
  type VaAttemptInput,
  type VeteranConfirmationResult,
} from '../../src/identity/index.js';
import {
  createVaConfirmationHttpAdapter,
  type VaConfirmationLogRecord,
} from '../../src/identity/va-confirmation-http.js';
import { VA_CONFIRMATION_SANDBOX_BASE_URL } from '../../src/identity/va-confirmation.js';
import { canonicalize, fingerprintRequest } from '../../src/idempotency/fingerprint.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import {
  TEST_FINGERPRINT_KEY,
  TEST_FINGERPRINT_KEY_ID,
  TEST_SESSION_SECRET,
  testDatabaseUrl,
  validEnv,
} from '../helpers/env.js';

let app: StartedApp;
let disabledApp: StartedApp;

const env = (extra: Record<string, string>) =>
  validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl(), ...extra });

beforeAll(async () => {
  app = await startApp({ env: env({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }), listen: false });
  disabledApp = await startApp({ env: env({}), listen: false });
});

afterAll(async () => {
  await disabledApp.close();
  await app.close();
});

const KEYRING: FingerprintKeyring = {
  current: { id: TEST_FINGERPRINT_KEY_ID, secret: TEST_FINGERPRINT_KEY },
};
const ROTATED_KEY = { id: 'test-k2', secret: Buffer.alloc(32, 7).toString('base64') };

const projectionFields = (zipCode: string) => ({
  firstName: 'Testfirst',
  lastName: 'Testlast',
  birthDate: '1960-02-29',
  streetAddressLine1: '1 Example Way',
  city: 'Exampleton',
  state: 'CA',
  zipCode,
});
const body = (zipCode: string) => ({ ...projectionFields(zipCode), noticeVersion: VA_NOTICE_V1 });

/** A signed-in person in their own tenant (or `tenantId`), named to match `body`. */
async function person(
  started: StartedApp = app,
  options: { tenantId?: string; displayName?: string | null } = {},
) {
  const pool = started.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = options.tenantId ?? randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vac-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const displayName = options.displayName === undefined ? 'Testfirst T.' : options.displayName;
  if (displayName !== null) await setUserDisplayName(pool, tenantId, user.userId, displayName);
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  const headers = { authorization: `Bearer ${session.credential}` };
  const rows = async () =>
    (
      await pool.query<{
        status: string;
        failure_class: string | null;
        notice_version: string | null;
        identity_hash: string | null;
        identity_key_id: string | null;
        request_fingerprint: string | null;
        fingerprint_key_id: string | null;
      }>(
        `SELECT status, failure_class, notice_version, identity_hash, identity_key_id,
                request_fingerprint, fingerprint_key_id
           FROM veteran_verifications
          WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
          ORDER BY created_at`,
        [tenantId, user.userId],
      )
    ).rows;
  const attempts = async () => (await rows()).length;
  const input = (zip: string, idempotencyKey: string = randomUUID()): VaAttemptInput => ({
    tenantId,
    userId: user.userId,
    projection: { ...projectionFields(zip), country: 'USA' },
    noticeVersion: VA_NOTICE_V1,
    idempotencyKey,
    providerEnvironment: 'NONE',
  });
  return { pool, tenantId, user, headers, rows, attempts, input };
}

function confirm(
  headers: Record<string, string>,
  payload: object,
  key: string = randomUUID(),
  started: StartedApp = app,
) {
  return started.server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/va/confirm',
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });
}

function selfAttest(headers: Record<string, string>, started: StartedApp = app, payload?: object) {
  return started.server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/commands/self-attest',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    ...(payload !== undefined ? { payload } : {}),
  });
}

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;
const resources = (headers: Record<string, string>, started: StartedApp = app) =>
  started.server.inject({ method: 'GET', url: '/api/v0/resources', headers });
const me = async (headers: Record<string, string>) =>
  (await app.server.inject({ method: 'GET', url: '/api/v0/veterans/me', headers })).json<{
    id_verification: Record<string, unknown>;
  }>().id_verification;

const fixtureAsk: AskVa = (projection) => new FixtureVeteranConfirmation().confirm(projection);

/** A port call the test answers by hand, to look between the two transactions. */
function heldAsk() {
  let answer: (result: VeteranConfirmationResult) => void = () => undefined;
  let asked: () => void = () => undefined;
  const providerAsked = new Promise<void>((resolve) => (asked = resolve));
  const ask: AskVa = () => {
    asked();
    return new Promise((resolve) => (answer = resolve));
  };
  return { ask, providerAsked, answer: (result: VeteranConfirmationResult) => answer(result) };
}

const revoke = (pool: Pool, tenantId: string, userId: string) =>
  pool.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        provider_environment, projection_id, settled_at)
     VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'REVOKED', 'SUAS', 'test', 'NONE',
             'VA_CONFIRMATION_V1_REQUIRED_ONLY', now())`,
    [randomUUID(), tenantId, userId],
  );

describe('confirm and the gate', () => {
  it('blocks before any attempt and opens once VERIFIED', async () => {
    const { headers } = await person();
    expect(await me(headers)).toEqual({
      method: 'VA_VETERAN_STATUS',
      status: 'NOT_STARTED',
      not_confirmed_reason: null,
      verified_at: null,
      failure_class: null,
    });
    expect((await resources(headers)).statusCode).toBe(403);

    const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(response.statusCode).toBe(200);
    const result = response.json<{ status: string; verified_at: string }>();
    expect(result).toMatchObject({ status: 'VERIFIED', not_confirmed_reason: null });
    expect(Date.parse(result.verified_at)).not.toBeNaN();
    expect(await me(headers)).toMatchObject({ method: 'VA_VETERAN_STATUS', status: 'VERIFIED' });
    expect((await resources(headers)).statusCode).toBe(200);
  });

  it.each([
    [VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38, 'NOT_CONFIRMED', 'NOT_TITLE_38', null],
    [VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND, 'NOT_CONFIRMED', 'PERSON_NOT_FOUND', null],
    [
      VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR,
      'UNAVAILABLE',
      'ERROR',
      'PROVIDER_UNAVAILABLE',
    ],
    // A VA 400 is correctable and never NOT_CONFIRMED (owner M2).
    [VA_CONFIRMATION_FIXTURE_ZIPS.REQUEST_INVALID, 'UNAVAILABLE', null, 'REQUEST_INVALID'],
    // An unlisted ZIP fails closed.
    ['95112', 'NOT_CONFIRMED', 'PERSON_NOT_FOUND', null],
  ])('ZIP %s settles %s (%s) and keeps the gate closed', async (zip, status, reason, failure) => {
    const { headers } = await person();
    const response = await confirm(headers, body(zip));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status,
      not_confirmed_reason: reason,
      verified_at: null,
      failure_class: failure,
    });
    expect(await me(headers)).toMatchObject({ status, not_confirmed_reason: reason });
    expect((await resources(headers)).statusCode).toBe(403);
  });

  it('keeps earlier results and lets a corrected retry pass', async () => {
    const { headers, attempts } = await person();
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND));
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(await attempts()).toBe(2);
    expect((await resources(headers)).statusCode).toBe(200);
  });

  it('replays the same Idempotency-Key with the same answer and stores a keyed fingerprint', async () => {
    const { headers, attempts, rows, user } = await person();
    const key = randomUUID();
    const first = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38), key);
    const second = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38), key);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await attempts()).toBe(1);

    const changed = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED), key);
    expect(changed.statusCode).toBe(409);
    expect(errorCode(changed)).toBe('IDEMPOTENCY_CONFLICT');

    // HMAC under SUAS_FINGERPRINT_KEY, so a plain SHA-256 of a guessed projection misses.
    const canonical = {
      ...projectionFields(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38),
      country: 'USA',
      notice_version: VA_NOTICE_V1,
      actor_id: user.userId,
    };
    const [stored] = await rows();
    expect(stored?.fingerprint_key_id).toBe(TEST_FINGERPRINT_KEY_ID);
    expect(stored?.request_fingerprint).not.toBe(fingerprintRequest(canonical));
    const purposeKey = createHmac('sha256', Buffer.from(TEST_FINGERPRINT_KEY, 'base64'))
      .update(VA_CONFIRMATION_FINGERPRINT_LABEL)
      .digest();
    expect(stored?.request_fingerprint).toBe(
      createHmac('sha256', purposeKey).update(canonicalize(canonical)).digest('hex'),
    );
  });

  it('treats a retried key after an outage as a new attempt, not a replay', async () => {
    const { headers, attempts } = await person();
    const key = randomUUID();
    const down = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR), key);
    expect(down.json()).toMatchObject({ status: 'UNAVAILABLE' });
    const retry = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED), key);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ status: 'VERIFIED' });
    expect(await attempts()).toBe(2);
  });

  it('refuses the sixth VA-answered attempt in 24 hours with 429', async () => {
    const { headers, attempts } = await person();
    for (let i = 0; i < 5; i += 1) {
      const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND));
      expect(response.statusCode).toBe(200);
    }
    const sixth = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(sixth.statusCode).toBe(429);
    expect(errorCode(sixth)).toBe('VERIFICATION_ATTEMPT_LIMIT');
    expect(sixth.json<{ error: { message: string } }>().error.message).toContain(
      'in the last 24 hours',
    );
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(await attempts()).toBe(5);
    expect((await resources(headers)).statusCode).toBe(403);
  });

  it('never counts outages or refused requests toward the limit (owner M5)', async () => {
    const { headers, attempts } = await person();
    for (let i = 0; i < 4; i += 1) {
      await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR));
      await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.REQUEST_INVALID));
    }
    const passes = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(passes.statusCode).toBe(200);
    expect(passes.json()).toMatchObject({ status: 'VERIFIED' });
    expect(await attempts()).toBe(9);
  });

  it('never counts outages or VA 400s toward the 20-call cap (owner, suas #238)', async () => {
    const { pool, tenantId, user, headers, attempts } = await person();
    // Settled UNAVAILABLE rows of every outage class, more than the cap, written directly.
    const classes = ['PROVIDER_UNAVAILABLE', 'TIMEOUT', 'REQUEST_INVALID', 'NETWORK_ERROR'];
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          failure_class, idempotency_key, settled_at)
       SELECT gen_random_uuid(), $1, $2, 'VA_VETERAN_STATUS', 'UNAVAILABLE', 'VA', 'test',
              ($3::text[])[1 + i % 4], gen_random_uuid()::text, now()
         FROM generate_series(1, $4::int) AS i`,
      [tenantId, user.userId, classes, VA_CONFIRMATION_MAX_CALLS + 5],
    );
    const passes = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(passes.statusCode).toBe(200);
    expect(passes.json()).toMatchObject({ status: 'VERIFIED' });
    expect(await attempts()).toBe(VA_CONFIRMATION_MAX_CALLS + 6);
  });

  it('refuses at 20 counted VA calls in 24 hours with the cap message', async () => {
    const { pool, tenantId, user, headers, attempts } = await person();
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          not_confirmed_reason, idempotency_key, settled_at)
       SELECT gen_random_uuid(), $1, $2, 'VA_VETERAN_STATUS', 'NOT_CONFIRMED', 'VA', 'test',
              'PERSON_NOT_FOUND', gen_random_uuid()::text, now()
         FROM generate_series(1, $3::int)`,
      [tenantId, user.userId, VA_CONFIRMATION_MAX_CALLS],
    );
    const capped = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(capped.statusCode).toBe(429);
    expect(errorCode(capped)).toBe('VERIFICATION_ATTEMPT_LIMIT');
    expect(capped.json<{ error: { message: string } }>().error.message).toContain(
      `${VA_CONFIRMATION_MAX_CALLS} VA checks`,
    );
    expect(Number(capped.headers['retry-after'])).toBeGreaterThan(0);
    expect(await attempts()).toBe(VA_CONFIRMATION_MAX_CALLS);
    // Self-attestation stays open.
    expect((await selfAttest(headers)).statusCode).toBe(200);
  });

  it('answers an already VERIFIED person without a new attempt', async () => {
    const { headers, attempts } = await person();
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    const again = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'VERIFIED' });
    expect(await attempts()).toBe(1);
  });

  it("does not show one person's result to another", async () => {
    const a = await person();
    const b = await person();
    await confirm(a.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(await me(b.headers)).toMatchObject({ status: 'NOT_STARTED' });
    expect((await resources(b.headers)).statusCode).toBe(403);
  });
});

describe('no database lock across the VA call (R9.1 D8)', () => {
  it('holds no lock while VA answers, and refuses a second attempt in flight', async () => {
    const { pool, tenantId, user, input, rows, headers } = await person();
    const held = heldAsk();
    const inFlight = confirmVeteranStatus(pool, KEYRING, held.ask, input('00001'));
    await held.providerAsked;

    const lockKey = `va-confirmation:${tenantId}:${user.userId}`;
    const client = await pool.connect();
    try {
      const free = await client.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock(hashtext($1)) AS ok`,
        [lockKey],
      );
      expect(free.rows[0]?.ok).toBe(true);
      await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]);
    } finally {
      client.release();
    }
    expect((await rows()).map((row) => row.status)).toEqual(['PENDING']);

    await expect(
      confirmVeteranStatus(pool, KEYRING, fixtureAsk, input('00001')),
    ).rejects.toBeInstanceOf(CommandInProgressError);

    held.answer({ status: 'VERIFIED' });
    expect((await inFlight).status).toBe('VERIFIED');
    expect(await me(headers)).toMatchObject({ status: 'VERIFIED' });
  });

  it('stamps the result at settle time, so the attempt that settles last is the standing', async () => {
    const { pool, tenantId, user, input, headers } = await person();
    const held = heldAsk();
    const slow = confirmVeteranStatus(pool, KEYRING, held.ask, input('00002'));
    await held.providerAsked;
    await new Promise((resolve) => setTimeout(resolve, 25));
    held.answer({ status: 'NOT_CONFIRMED', notConfirmedReason: 'PERSON_NOT_FOUND' });
    await slow;
    const stamped = await pool.query<{ waited: boolean }>(
      `SELECT settled_at >= created_at + interval '20 milliseconds' AS waited
         FROM veteran_verifications WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, user.userId],
    );
    expect(stamped.rows).toEqual([{ waited: true }]);

    await confirmVeteranStatus(pool, KEYRING, fixtureAsk, input('00005'));
    expect(await me(headers)).toMatchObject({ status: 'UNAVAILABLE' });
  });

  it('settles an attempt left PENDING by a lost process as a timeout', async () => {
    const { pool, tenantId, user, headers, rows } = await person();
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          created_at)
       VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'PENDING', 'SUAS', 'test',
               now() - interval '10 minutes')`,
      [randomUUID(), tenantId, user.userId],
    );
    const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(response.json()).toMatchObject({ status: 'VERIFIED' });
    expect((await rows()).map((row) => [row.status, row.failure_class])).toEqual([
      ['UNAVAILABLE', 'TIMEOUT'],
      ['VERIFIED', null],
    ]);
  });
});

describe('fingerprint key rotation (R9.1 D5)', () => {
  it('replays under the previous key, and a retry after the old key is gone is a new attempt', async () => {
    const { pool, input, attempts } = await person();
    const key = randomUUID();
    await confirmVeteranStatus(pool, KEYRING, fixtureAsk, input('00003', key));

    const rotating: FingerprintKeyring = { current: ROTATED_KEY, previous: KEYRING.current };
    const replay = await confirmVeteranStatus(pool, rotating, fixtureAsk, input('00003', key));
    expect(replay).toMatchObject({ status: 'NOT_CONFIRMED', notConfirmedReason: 'NOT_TITLE_38' });
    expect(await attempts()).toBe(1);

    // The old key was dropped: the stored fingerprint cannot be checked, so never a 409.
    const rotated: FingerprintKeyring = { current: ROTATED_KEY };
    const fresh = await confirmVeteranStatus(pool, rotated, fixtureAsk, input('00002', key));
    expect(fresh).toMatchObject({
      status: 'NOT_CONFIRMED',
      notConfirmedReason: 'PERSON_NOT_FOUND',
    });
    expect(await attempts()).toBe(2);
  });

  it('finds an identity verified under the previous key', async () => {
    const tenantId = randomUUID();
    const first = await person(app, { tenantId });
    await confirmVeteranStatus(first.pool, KEYRING, fixtureAsk, first.input('00001'));

    const second = await person(app, { tenantId });
    const rotating: FingerprintKeyring = { current: ROTATED_KEY, previous: KEYRING.current };
    await expect(
      confirmVeteranStatus(second.pool, rotating, fixtureAsk, second.input('00001')),
    ).rejects.toBeInstanceOf(VaIdentityAlreadyVerifiedError);
  });
});

describe('identity binding (owner review of #236, must-fix 1)', () => {
  it.each([
    ['another name', 'Someone Else'],
    ['no display name', null],
    ['the first name only', 'Testfirst'],
  ])(
    'refuses a typed name that does not match the account (%s), with no VA call or count',
    async (_case, displayName) => {
      const { headers, attempts } = await person(app, { displayName });
      const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
      expect(response.statusCode).toBe(409);
      expect(errorCode(response)).toBe('VA_NAME_MISMATCH');
      expect(await attempts()).toBe(0);
    },
  );

  it('accepts the full name or the last-name initial, ignoring case, accents and punctuation', async () => {
    for (const displayName of ['Testfirst Testlast', 'testfirst t', 'Tëstfirst T.']) {
      const { headers } = await person(app, { displayName });
      const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
      expect(response.json(), displayName).toMatchObject({ status: 'VERIFIED' });
    }
  });

  it('keeps an identity hash on answers VA gave, never on outages', async () => {
    const { headers, rows } = await person();
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR));
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND));
    const [outage, answered] = await rows();
    expect(outage?.identity_hash).toBeNull();
    expect(answered?.identity_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(answered?.identity_key_id).toBe(TEST_FINGERPRINT_KEY_ID);
  });

  it('refuses a second account with the same identity, generically, and counts it', async () => {
    const tenantId = randomUUID();
    const first = await person(app, { tenantId });
    await confirm(first.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));

    const second = await person(app, { tenantId });
    const response = await confirm(second.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'VA_IDENTITY_ALREADY_VERIFIED',
        message: "These details can't be used to verify this account.",
      },
    });
    expect((await second.rows()).map((row) => [row.status, row.failure_class])).toEqual([
      ['UNAVAILABLE', 'IDENTITY_CONFLICT'],
    ]);
    expect(await me(second.headers)).toMatchObject({ status: 'NOT_STARTED' });
    expect((await resources(second.headers)).statusCode).toBe(403);

    // Conflicts count, so probing identities stops at the limit.
    for (let i = 0; i < 4; i += 1) {
      await confirm(second.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    }
    const capped = await confirm(second.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(capped.statusCode).toBe(429);
  });

  it('checks the identity only after VA verifies, so a name and birth date alone reveal nothing', async () => {
    const tenantId = randomUUID();
    const first = await person(app, { tenantId });
    await confirm(first.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));

    // Same name and birth date, but details VA does not confirm: an ordinary answer, no 409.
    const second = await person(app, { tenantId });
    for (const zip of [
      VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND,
      VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR,
    ]) {
      const response = await confirm(second.headers, body(zip));
      expect(response.statusCode).toBe(200);
    }
  });

  it('refuses the later of two accounts verifying the same identity at once', async () => {
    const tenantId = randomUUID();
    const slow = await person(app, { tenantId });
    const quick = await person(app, { tenantId });
    const held = heldAsk();
    const inFlight = confirmVeteranStatus(slow.pool, KEYRING, held.ask, slow.input('00001'));
    await held.providerAsked;
    await confirmVeteranStatus(quick.pool, KEYRING, fixtureAsk, quick.input('00001'));

    held.answer({ status: 'VERIFIED' });
    await expect(inFlight).rejects.toBeInstanceOf(VaIdentityAlreadyVerifiedError);
    expect((await slow.rows()).map((row) => row.failure_class)).toEqual(['IDENTITY_CONFLICT']);
    expect((await resources(slow.headers)).statusCode).toBe(403);
  });

  it('lets the identity verify on another account once the first is revoked', async () => {
    const tenantId = randomUUID();
    const first = await person(app, { tenantId });
    await confirm(first.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    await revoke(first.pool, tenantId, first.user.userId);

    const second = await person(app, { tenantId });
    const response = await confirm(second.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(response.json()).toMatchObject({ status: 'VERIFIED' });
  });
});

describe('pre-call notice (owner M6, R9.1 D6)', () => {
  it('needs the current notice version and stores it on the attempt', async () => {
    const { headers, rows } = await person();
    const { noticeVersion: _omitted, ...withoutNotice } = body(
      VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED,
    );
    for (const payload of [withoutNotice, { ...withoutNotice, noticeVersion: 'va-notice-v0' }]) {
      const response = await confirm(headers, payload);
      expect(response.statusCode).toBe(400);
      expect(errorCode(response)).toBe('VA_NOTICE_VERSION_REQUIRED');
    }
    expect(await rows()).toEqual([]);

    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect((await rows()).map((row) => row.notice_version)).toEqual([VA_NOTICE_V1]);
  });
});

describe('self-attestation (D-016 fallback, R9.1 D1)', () => {
  it('opens the gate with no VA call, even when VA confirmation is disabled', async () => {
    for (const started of [app, disabledApp]) {
      const { headers } = await person(started);
      const response = await selfAttest(headers, started);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ method: 'SELF_ATTESTATION', status: 'VERIFIED' });
      expect((await resources(headers, started)).statusCode).toBe(200);
    }
  });

  it('is not limited by VA attempts and is not repeated once VERIFIED', async () => {
    const { headers, pool, tenantId, user } = await person();
    for (let i = 0; i < 5; i += 1) {
      await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND));
    }
    expect((await selfAttest(headers)).statusCode).toBe(200);
    expect((await selfAttest(headers)).json()).toMatchObject({ method: 'SELF_ATTESTATION' });
    const count = await pool.query(
      `SELECT 1 FROM veteran_verifications
        WHERE tenant_id = $1 AND user_id = $2 AND method = 'SELF_ATTESTATION'`,
      [tenantId, user.userId],
    );
    expect(count.rowCount).toBe(1);
    expect(await me(headers)).toMatchObject({ method: 'SELF_ATTESTATION', status: 'VERIFIED' });
  });

  it('stays open when a later VA attempt is not confirmed', async () => {
    const { headers } = await person();
    await selfAttest(headers);
    const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38));
    expect(response.json()).toMatchObject({ status: 'NOT_CONFIRMED' });
    expect((await resources(headers)).statusCode).toBe(200);
  });

  it('is refused, and closes, under a REVOKED standing', async () => {
    const revokedFirst = await person();
    await revoke(revokedFirst.pool, revokedFirst.tenantId, revokedFirst.user.userId);
    const refused = await selfAttest(revokedFirst.headers);
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused)).toBe('VERIFICATION_REVOKED');

    const attestedFirst = await person();
    await selfAttest(attestedFirst.headers);
    await revoke(attestedFirst.pool, attestedFirst.tenantId, attestedFirst.user.userId);
    expect((await resources(attestedFirst.headers)).statusCode).toBe(403);
    expect(await me(attestedFirst.headers)).toMatchObject({ status: 'REVOKED' });
  });

  it('needs an Idempotency-Key and takes no fields', async () => {
    const { headers } = await person();
    const noKey = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/commands/self-attest',
      headers,
    });
    expect(noKey.statusCode).toBe(400);
    expect((await selfAttest(headers, app, { served: true })).statusCode).toBe(400);
    expect((await selfAttest(headers, app, {})).statusCode).toBe(200);
  });
});

// No lift path exists in code yet; until then nothing reopens the gate.
describe('a REVOKED standing', () => {
  it('is refused with 403 and takes no attempt', async () => {
    const { headers, pool, tenantId, user, attempts } = await person();
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    await revoke(pool, tenantId, user.userId);
    expect((await resources(headers)).statusCode).toBe(403);

    const again = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(again.statusCode).toBe(403);
    expect(errorCode(again)).toBe('VERIFICATION_REVOKED');
    expect(await attempts()).toBe(2);
    expect(await me(headers)).toMatchObject({ status: 'REVOKED' });
  });

  it('refuses an attempt that passed the route check before the revocation', async () => {
    const { pool, tenantId, user, attempts, input } = await person();
    await revoke(pool, tenantId, user.userId);
    // The route's pre-check already ran; the attempt re-reads the standing under its lock.
    await expect(beginVaAttempt(pool, KEYRING, input('00001'))).rejects.toBeInstanceOf(
      VeteranConfirmationRevokedError,
    );
    expect(await attempts()).toBe(1);
  });

  it.each([
    ['revoked', 'revoke'],
    ['deleted', 'delete'],
  ] as const)(
    'settles without holding the identity when the person is %s during the VA call',
    async (_case, action) => {
      const tenantId = randomUUID();
      const first = await person(app, { tenantId });
      const attempt = first.input('00001');
      const start = await beginVaAttempt(first.pool, KEYRING, attempt);
      if (start.kind !== 'started') throw new Error('expected a started attempt');
      if (action === 'revoke') await revoke(first.pool, tenantId, first.user.userId);
      else await softDeleteUser(first.pool, tenantId, first.user.userId);
      await settleVaAttempt(first.pool, KEYRING, attempt, start.verificationId, {
        status: 'VERIFIED',
      });
      const released = await first.pool.query<{ identity_hash: string | null; released: boolean }>(
        `SELECT identity_hash, identity_released_at IS NOT NULL AS released
           FROM veteran_verifications WHERE verification_id = $1`,
        [start.verificationId],
      );
      expect(released.rows).toEqual([{ identity_hash: null, released: true }]);

      const second = await person(app, { tenantId });
      const response = await confirm(second.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
      expect(response.json()).toMatchObject({ status: 'VERIFIED' });
    },
  );

  it('wins over an attempt that settles VERIFIED after it', async () => {
    const { headers, pool, tenantId, user, input } = await person();
    const attempt = input('00001');
    const start = await beginVaAttempt(pool, KEYRING, attempt);
    if (start.kind !== 'started') throw new Error('expected a started attempt');
    await revoke(pool, tenantId, user.userId);
    await settleVaAttempt(pool, KEYRING, attempt, start.verificationId, { status: 'VERIFIED' });

    expect(await me(headers)).toMatchObject({ status: 'REVOKED' });
    expect((await resources(headers)).statusCode).toBe(403);
  });
});

describe('confirm request checks', () => {
  it('needs a session, an Idempotency-Key and a valid projection', async () => {
    const { headers, attempts } = await person();
    const valid = body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED);
    const unauthenticated = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/va/confirm',
      payload: valid,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const noKey = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/va/confirm',
      headers,
      payload: valid,
    });
    expect(noKey.statusCode).toBe(400);

    for (const payload of [
      { ...valid, ssn: '000-00-0000' },
      { ...valid, country: 'MEX' },
      { ...valid, birthDate: '2999-01-01' },
      { ...valid, birthDate: '1990-02-30' },
      { ...valid, firstName: 'R2D2' },
      { ...valid, zipCode: '' },
    ]) {
      const response = await confirm(headers, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(errorCode(response)).toBe('VALIDATION_FAILED');
    }
    expect((await confirm(headers, { ...valid, country: 'USA' })).statusCode).toBe(200);
    expect(await attempts()).toBe(1);
  });

  it('answers 503 when confirmation is disabled', async () => {
    const { headers } = await person(disabledApp);
    const response = await confirm(
      headers,
      body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED),
      randomUUID(),
      disabledApp,
    );
    expect(response.statusCode).toBe(503);
    expect(errorCode(response)).toBe('ID_VERIFICATION_UNAVAILABLE');
  });
});

describe('projection values are never kept (R9.1 storage rule, D035 §13)', () => {
  it('leaves no sentinel in logs, rows, events or responses', async () => {
    const sentinel = {
      firstName: 'Zqxsentinelfirst',
      lastName: 'Zqxsentinellast',
      birthDate: '1931-07-13',
      streetAddressLine1: '999 Zqxsentinel Street',
      city: 'Zqxsentinelcity',
      state: 'Zqxsentinelstate',
      zipCode: 'ZQX99',
    };
    const lines: string[] = [];
    const adapterLogs: VaConfirmationLogRecord[] = [];
    let sentToVa = '';
    const port = createVaConfirmationHttpAdapter({
      baseUrl: VA_CONFIRMATION_SANDBOX_BASE_URL,
      apiKey: 'synthetic-key-not-real',
      environment: 'SANDBOX',
      logger: (record) => adapterLogs.push(record),
      transport: {
        fetch(_url, init) {
          sentToVa = init.body as string;
          return Promise.resolve(
            new Response(JSON.stringify({ veteran_status: 'confirmed' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      },
    });
    const server = createServer({
      config: { ...app.config, logLevel: 'trace' },
      buildInfo: () => app.buildInfo,
      pool: app.pool!,
      challengeDelivery: app.challengeDelivery,
      mfa: app.mfa,
      veteranConfirmation: port,
      logStream: { write: (line) => void lines.push(line) },
    });
    const consoleLines: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void consoleLines.push(args)),
    );

    try {
      const { headers, pool, tenantId } = await person(app, {
        displayName: `${sentinel.firstName} ${sentinel.lastName}`,
      });
      const post = (payload: object) =>
        server.inject({
          method: 'POST',
          url: '/api/v0/veterans/me/verification/va/confirm',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload: { ...payload, noticeVersion: VA_NOTICE_V1 },
        });
      // A refused body (unknown key) and an accepted one both carry the sentinels.
      const refused = await post({ ...sentinel, extra: sentinel.lastName });
      expect(refused.statusCode).toBe(400);
      const accepted = await post(sentinel);
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(sentToVa)).toMatchObject({ firstName: sentinel.firstName });

      const dump = async (table: string, where: string) =>
        JSON.stringify(
          (await pool.query(`SELECT * FROM ${table} WHERE ${where}`, [tenantId])).rows,
        );
      const stored = [
        await dump('veteran_verifications', 'tenant_id = $1'),
        await dump('audit_events', 'tenant_id = $1'),
        await dump('domain_events', 'tenant_id = $1'),
        await dump('command_idempotency_records', 'tenant_id = $1'),
      ];
      expect(stored[0]).toContain('VERIFIED');
      expect(stored[1]).toContain('VETERAN_VERIFICATION_SETTLED');

      const everything = [
        ...lines,
        JSON.stringify(consoleLines),
        JSON.stringify(adapterLogs),
        refused.body,
        accepted.body,
        ...stored,
      ].join('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const value of Object.values(sentinel)) {
        expect(everything).not.toContain(value);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      await server.close();
    }
  });
});
