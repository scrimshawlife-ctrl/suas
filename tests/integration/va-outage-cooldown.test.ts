/**
 * AT09 (suas #287): the shared VA outage cooldown. 3 transport outages in a row pause VA for
 * every confirm request for 60 seconds (the outage answer, no call, no attempt); then one
 * request probes VA. The port is a counting fake; the clock moves by ageing the row.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createServer } from '../../src/http/server.js';
import {
  createUser,
  setUserDisplayName,
  VA_CONFIRMATION_MAX_ATTEMPTS,
  VA_NOTICE_V1,
  type VeteranConfirmationPort,
  type VeteranConfirmationResult,
} from '../../src/identity/index.js';
import {
  acquireVaCall,
  recordVaCallOutcome,
  VA_OUTAGE_COOLDOWN_SECONDS,
  VA_OUTAGE_THRESHOLD,
} from '../../src/identity/va-outage-cooldown.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { closeVaOutageCooldown } from '../helpers/db.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

let app: StartedApp;
let server: StartedApp['server'];

/** The fake VA: counts calls and answers with whatever the test set last. */
let calls = 0;
let answer: () => Promise<VeteranConfirmationResult>;
const port: VeteranConfirmationPort = {
  implementation: 'counting-fake',
  providerEnvironment: 'NONE',
  confirm: () => {
    calls += 1;
    return answer();
  },
};
const answers = (result: VeteranConfirmationResult) => () => Promise.resolve(result);

const OUTAGE: VeteranConfirmationResult = {
  status: 'UNAVAILABLE',
  failureClass: 'PROVIDER_UNAVAILABLE',
};
/** VA answered, but with ERROR for this one lookup: not a transport outage. */
const PER_LOOKUP_ERROR: VeteranConfirmationResult = {
  status: 'UNAVAILABLE',
  notConfirmedReason: 'ERROR',
  failureClass: 'PROVIDER_UNAVAILABLE',
};
const VA_400: VeteranConfirmationResult = {
  status: 'UNAVAILABLE',
  failureClass: 'REQUEST_INVALID',
};
const NOT_FOUND: VeteranConfirmationResult = {
  status: 'NOT_CONFIRMED',
  notConfirmedReason: 'PERSON_NOT_FOUND',
};

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_VA_CONFIRMATION_MODE: 'fixture',
    }),
    listen: false,
  });
  server = createServer({
    config: app.config,
    buildInfo: () => app.buildInfo,
    pool: app.pool!,
    challengeDelivery: app.challengeDelivery,
    mfa: app.mfa,
    veteranConfirmation: port,
    logger: false,
  });
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  calls = 0;
  answer = answers(NOT_FOUND);
  await closeVaOutageCooldown(app.pool!);
});

const cooldown = (set: string) => app.pool!.query(`UPDATE va_outage_cooldown SET ${set}`);
/** Moves the clock past the cooldown. */
const expire = () =>
  cooldown(`opened_at = now() - make_interval(secs => ${VA_OUTAGE_COOLDOWN_SECONDS + 1})`);

/** A signed-in person whose display name matches the typed name. */
async function person() {
  const pool = app.pool!;
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vaoc-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await setUserDisplayName(pool, tenantId, user.userId, 'Testfirst T.');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  const attempts = async () =>
    (
      await pool.query(
        `SELECT 1 FROM veteran_verifications
          WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'`,
        [tenantId, user.userId],
      )
    ).rowCount;
  return { headers: { authorization: `Bearer ${session.credential}` }, attempts };
}

const confirm = (headers: Record<string, string>) =>
  server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/va/confirm',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: {
      firstName: 'Testfirst',
      lastName: 'Testlast',
      birthDate: '1960-02-29',
      streetAddressLine1: '1 Example Way',
      city: 'Exampleton',
      state: 'CA',
      zipCode: '00001',
      noticeVersion: VA_NOTICE_V1,
    },
  });

const errorCode = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;
const statusOf = async (headers: Record<string, string>) =>
  (await confirm(headers)).json<{ status: string }>().status;

/** What a VA 5xx answers today; a request held back by the cooldown gets the same. */
const OUTAGE_BODY = {
  status: 'UNAVAILABLE',
  not_confirmed_reason: null,
  verified_at: null,
  failure_class: 'PROVIDER_UNAVAILABLE',
};

/** VA cannot be reached `VA_OUTAGE_THRESHOLD` times in a row, which pauses it. */
async function pause(outage: () => Promise<VeteranConfirmationResult> = answers(OUTAGE)) {
  const { headers } = await person();
  answer = outage;
  for (let i = 0; i < VA_OUTAGE_THRESHOLD; i += 1) {
    expect((await confirm(headers)).json()).toMatchObject({ status: 'UNAVAILABLE' });
  }
  answer = answers(NOT_FOUND);
}

describe('VA outage cooldown (AT09)', () => {
  it.each([
    ['VA 5xx', answers(OUTAGE)],
    ['timeout', answers({ status: 'UNAVAILABLE', failureClass: 'TIMEOUT' })],
    ['network failure', () => Promise.reject(new Error('socket hang up'))],
  ])('3 in a row (%s) pause VA for every request: no call, no attempt', async (_, outage) => {
    await pause(outage);
    expect(calls).toBe(VA_OUTAGE_THRESHOLD);

    const others = await Promise.all([1, 2, 3, 4, 5].map(person));
    const responses = await Promise.all(others.map((other) => confirm(other.headers)));
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(OUTAGE_BODY);
    }
    expect(calls).toBe(VA_OUTAGE_THRESHOLD);
    expect(await Promise.all(others.map((other) => other.attempts()))).toEqual([0, 0, 0, 0, 0]);

    // Self-attestation is still offered while VA is paused.
    const attest = await server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/commands/self-attest',
      headers: { ...others[0]!.headers, 'idempotency-key': randomUUID() },
    });
    expect(attest.statusCode).toBe(200);
  });

  it('pauses on the third outage in a row, and a VA answer in between restarts the count', async () => {
    const { headers } = await person();
    const send = async (result: VeteranConfirmationResult) => {
      answer = answers(result);
      await confirm(headers);
    };
    await send(OUTAGE);
    await send(OUTAGE);
    await send(NOT_FOUND);
    await send(OUTAGE);
    await send(OUTAGE);
    expect(calls).toBe(5);
    await send(OUTAGE);
    expect(calls).toBe(6);
    expect(await statusOf((await person()).headers)).toBe('UNAVAILABLE');
    expect(calls).toBe(6);
  });

  it('is never paused by a per-lookup ERROR answer or a VA 400', async () => {
    const { headers } = await person();
    for (const result of [PER_LOOKUP_ERROR, VA_400]) {
      answer = answers(result);
      for (let i = 0; i < VA_OUTAGE_THRESHOLD + 1; i += 1) await confirm(headers);
    }
    expect(calls).toBe(2 * (VA_OUTAGE_THRESHOLD + 1));
    answer = answers(NOT_FOUND);
    expect(await statusOf((await person()).headers)).toBe('NOT_CONFIRMED');
    expect(calls).toBe(2 * (VA_OUTAGE_THRESHOLD + 1) + 1);
  });

  it('lets exactly one of many concurrent requests probe VA after the cooldown', async () => {
    await pause();
    await expire();
    calls = 0;

    let release: () => void = () => undefined;
    let asked: () => void = () => undefined;
    const providerAsked = new Promise<void>((resolve) => (asked = resolve));
    answer = () => {
      asked();
      return new Promise((resolve) => (release = () => resolve(NOT_FOUND)));
    };
    const people = await Promise.all([1, 2, 3, 4, 5, 6].map(person));
    let finished = 0;
    const pending = people.map((one) =>
      statusOf(one.headers).then((status) => {
        finished += 1;
        return status;
      }),
    );
    await providerAsked;
    // Everyone but the probe is answered while the probe's VA call is still open.
    await vi.waitFor(() => expect(finished).toBe(people.length - 1));
    release();
    expect((await Promise.all(pending)).sort()).toEqual([
      'NOT_CONFIRMED',
      ...Array<string>(people.length - 1).fill('UNAVAILABLE'),
    ]);
    const rows = await Promise.all(people.map((one) => one.attempts()));
    expect(rows.reduce<number>((sum, n) => sum + (n ?? 0), 0)).toBe(1);
    expect(calls).toBe(1);

    // The probe's answer closed the cooldown: the next request calls VA at once.
    answer = answers(NOT_FOUND);
    expect(await statusOf((await person()).headers)).toBe('NOT_CONFIRMED');
    expect(calls).toBe(2);
  });

  it('reopens on a failed probe and gives up a probe whose process died', async () => {
    await pause();
    await expire();
    calls = 0;
    answer = answers(OUTAGE);
    expect(await statusOf((await person()).headers)).toBe('UNAVAILABLE');
    expect(calls).toBe(1);
    // The probe found VA still down: paused again for a full cooldown.
    expect(await statusOf((await person()).headers)).toBe('UNAVAILABLE');
    expect(calls).toBe(1);

    // A probe that started and never finished holds the turn, until it goes stale.
    await expire();
    await cooldown(`probe_started_at = now()`);
    answer = answers(NOT_FOUND);
    expect(await statusOf((await person()).headers)).toBe('UNAVAILABLE');
    expect(calls).toBe(1);
    await cooldown(`probe_started_at = now() - interval '121 seconds'`);
    expect(await statusOf((await person()).headers)).toBe('NOT_CONFIRMED');
    expect(calls).toBe(2);
  });

  it('hands the probe turn back when the probe request makes no VA call', async () => {
    const capped = await person();
    for (let i = 0; i < VA_CONFIRMATION_MAX_ATTEMPTS; i += 1) await confirm(capped.headers);
    await pause();
    await expire();
    calls = 0;

    // The capped person is admitted as the probe but refused before VA.
    expect((await confirm(capped.headers)).statusCode).toBe(429);
    expect(calls).toBe(0);
    expect(await statusOf((await person()).headers)).toBe('NOT_CONFIRMED');
    expect(calls).toBe(1);
  });

  it('never counts outages, per-lookup ERRORs or VA 400s toward the 5 tries', async () => {
    const { headers, attempts } = await person();
    for (const result of [OUTAGE, PER_LOOKUP_ERROR, VA_400]) {
      answer = answers(result);
      for (let i = 0; i < VA_CONFIRMATION_MAX_ATTEMPTS; i += 1) {
        expect((await confirm(headers)).json()).toMatchObject({ status: 'UNAVAILABLE' });
        // Keep VA reachable: this test is about the tries, not the pause.
        await closeVaOutageCooldown(app.pool!);
      }
    }

    // None of those used a try: the 5 answered tries are all still there, then the cap trips.
    answer = answers(NOT_FOUND);
    for (let i = 0; i < VA_CONFIRMATION_MAX_ATTEMPTS; i += 1) {
      expect((await confirm(headers)).statusCode).toBe(200);
    }
    const capped = await confirm(headers);
    expect(capped.statusCode).toBe(429);
    expect(errorCode(capped)).toBe('VERIFICATION_ATTEMPT_LIMIT');
    expect(await attempts()).toBe(4 * VA_CONFIRMATION_MAX_ATTEMPTS);
    expect(calls).toBe(await attempts());
  });
});

describe('VA recovery probe ownership', () => {
  const state = async () =>
    (
      await app.pool!.query<{
        consecutive_failures: number;
        opened_at: string | null;
        probe_started_at: string | null;
      }>(
        'SELECT consecutive_failures, opened_at::text, probe_started_at::text FROM va_outage_cooldown',
      )
    ).rows[0];

  it.each([OUTAGE, NOT_FOUND])(
    'ignores a late ordinary call while a recovery probe owns the lease (%j)',
    async (lateResult) => {
      const ordinary = await acquireVaCall(app.pool!);
      expect(ordinary.kind).toBe('closed');
      await pause();
      await expire();
      const probe = await acquireVaCall(app.pool!);
      expect(probe.kind).toBe('probe');
      const before = await state();
      await recordVaCallOutcome(app.pool!, lateResult, ordinary);
      expect(await state()).toEqual(before);
      expect((await acquireVaCall(app.pool!)).kind).toBe('open');
      await recordVaCallOutcome(app.pool!, NOT_FOUND, probe);
      expect((await acquireVaCall(app.pool!)).kind).toBe('closed');
    },
  );

  it.each([OUTAGE, NOT_FOUND, undefined])(
    'ignores a replaced probe outcome (%j)',
    async (lateResult) => {
      await pause();
      await expire();
      const stale = await acquireVaCall(app.pool!);
      expect(stale.kind).toBe('probe');
      await cooldown("probe_started_at = now() - interval '121 seconds'");
      const current = await acquireVaCall(app.pool!);
      expect(current.kind).toBe('probe');
      const before = await state();
      await recordVaCallOutcome(app.pool!, lateResult, stale);
      expect(await state()).toEqual(before);
      expect((await acquireVaCall(app.pool!)).kind).toBe('open');
      await recordVaCallOutcome(app.pool!, NOT_FOUND, current);
      expect((await acquireVaCall(app.pool!)).kind).toBe('closed');
    },
  );
});
