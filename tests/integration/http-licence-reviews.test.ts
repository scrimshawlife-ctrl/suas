/**
 * The Veteran's licence routes over HTTP (suas-specs R10.1, proposal; L1.4, L1.5, L2.3,
 * L7.3): the named test that the path is never offered after a VA 400 (and 404, 5xx,
 * timeout), the submit check order and the answers it gives. The fixture VA adapter and
 * fixture licence reader run in TEST; the read runs inline. Synthetic data only.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createServer } from '../../src/http/server.js';
import { createUser, setUserDisplayName, VA_NOTICE_V1 } from '../../src/identity/index.js';
import { FixtureLicenceReader } from '../../src/identity/licence-reader-fixture.js';
import { createVaConfirmationHttpAdapter } from '../../src/identity/va-confirmation-http.js';
import { VA_CONFIRMATION_SANDBOX_BASE_URL } from '../../src/identity/va-confirmation.js';
import type { FetchTransport } from '../../src/identity/va-confirmation-http.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { closeVaOutageCooldown } from '../helpers/db.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { licenceSubmission } from '../helpers/licence.js';

type Server = StartedApp['server'];
let app: StartedApp;
let disabled: StartedApp;

const env = (extra: Record<string, string>) =>
  validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl(), ...extra });

beforeAll(async () => {
  await (async () => {
    app = await startApp({
      env: env({
        SUAS_VA_CONFIRMATION_MODE: 'fixture',
        SUAS_LICENCE_READER_MODE: 'fixture',
        SUAS_OBJECT_STORAGE_MODE: 'fake',
      }),
      listen: false,
    });
    disabled = await startApp({
      env: env({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }),
      listen: false,
    });
  })();
  await app.pool?.query(
    `UPDATE licence_reader_breaker SET consecutive_failures = 0, opened_at = NULL`,
  );
});

// The VA outage cooldown is one shared row (suas #287); each test starts with VA reachable.
beforeEach(() => closeVaOutageCooldown(app.pool!));

afterAll(async () => {
  await disabled.close();
  await app.close();
});

const LICENCE = '/api/v0/veterans/me/verification/licence';

/** A signed-in person whose display name fits the fixture licence identity. */
async function person(started: StartedApp = app) {
  const pool = started.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`lic-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await setUserDisplayName(pool, tenantId, user.userId, 'Synthetic V.');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  return { headers: { authorization: `Bearer ${session.credential}` }, userId: user.userId };
}

/** One VA attempt typed with the fixture licence identity. */
const confirm = (server: Server, headers: Record<string, string>, zipCode: string) =>
  server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/va/confirm',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: {
      firstName: 'Synthetic',
      lastName: 'Veteran',
      birthDate: '1970-01-02',
      streetAddressLine1: '1 Example Way',
      city: 'Exampleton',
      state: 'CA',
      zipCode,
      noticeVersion: VA_NOTICE_V1,
    },
  });

const offer = async (server: Server, headers: Record<string, string>) =>
  (await server.inject({ method: 'GET', url: LICENCE, headers })).json<{
    offered: boolean;
    notice_version: string;
    review: Record<string, unknown> | null;
  }>();

const send = (
  server: Server,
  headers: Record<string, string>,
  payload: object = licenceSubmission(),
  url = LICENCE,
) => server.inject({ method: 'POST', url, headers, payload });

const code = (response: { json: <T>() => T }) =>
  response.json<{ error: { code: string } }>().error.code;

/** The app's server, but with VA reached through the HTTP adapter over `transport`. */
function serverWithVa(transport: FetchTransport): Server {
  return createServer({
    config: app.config,
    buildInfo: () => app.buildInfo,
    pool: app.pool!,
    challengeDelivery: app.challengeDelivery,
    mfa: app.mfa,
    jobQueue: app.jobQueue,
    veteranConfirmation: createVaConfirmationHttpAdapter({
      baseUrl: VA_CONFIRMATION_SANDBOX_BASE_URL,
      apiKey: 'synthetic-key-not-real',
      environment: 'SANDBOX',
      transport,
    }),
    licenceReader: new FixtureLicenceReader(),
    objectStorage: app.objectStorage!,
    logger: false,
  });
}

describe('licence path is never offered after a VA 400', () => {
  /** L1.5: the confirm answer, then GET offered false, then 403 on submit. */
  async function expectNeverOffered(server: Server, zipCode: string, failureClass: string) {
    const { headers } = await person();
    const answer = await confirm(server, headers, zipCode);
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toMatchObject({ status: 'UNAVAILABLE', failure_class: failureClass });
    expect((await offer(server, headers)).offered).toBe(false);
    const refused = await send(server, headers);
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('LICENCE_REVIEW_NOT_OFFERED');
  }

  it('licence path is never offered after a VA 400', async () => {
    // The fixture's ZIP 00006 is a simulated VA 400.
    await expectNeverOffered(app.server, '00006', 'REQUEST_INVALID');
  });

  it('is never offered after a VA 404, 5xx or timeout either', async () => {
    const answering = (status: number): FetchTransport => ({
      fetch: () => Promise.resolve(new Response('{}', { status })),
    });
    const timeout: FetchTransport = {
      fetch: () => Promise.reject(new DOMException('timed out', 'TimeoutError')),
    };
    await expectNeverOffered(serverWithVa(answering(400)), 'ZQX01', 'REQUEST_INVALID');
    await expectNeverOffered(serverWithVa(answering(404)), 'ZQX02', 'PROVIDER_RESPONSE_INVALID');
    await expectNeverOffered(serverWithVa(answering(503)), 'ZQX03', 'PROVIDER_UNAVAILABLE');
    await expectNeverOffered(serverWithVa(timeout), 'ZQX04', 'TIMEOUT');
  });
});

describe('licence submit', () => {
  it('is offered after NOT_CONFIRMED, answers 202 and shows the read state', async () => {
    const { headers } = await person();
    expect((await confirm(app.server, headers, '00002')).json()).toMatchObject({
      status: 'NOT_CONFIRMED',
      not_confirmed_reason: 'PERSON_NOT_FOUND',
    });
    expect(await offer(app.server, headers)).toEqual({
      offered: true,
      notice_version: 'licence-notice-v1',
      review: null,
    });
    const sent = await send(app.server, headers);
    expect(sent.statusCode).toBe(202);
    // The in-memory queue reads inline, so the answer is already the read state.
    expect(sent.json()).toMatchObject({ status: 'AWAITING_REVIEW', disputable: false });
    expect(JSON.stringify(sent.json())).not.toMatch(/SYNTHETIC|F0000001|1970-01-02/);
    expect((await offer(app.server, headers)).review).toMatchObject({ status: 'AWAITING_REVIEW' });

    const again = await send(app.server, headers);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('LICENCE_REVIEW_OPEN');
  });

  it('checks sign-in before the body, then the notice, then the images by field name', async () => {
    const anonymous = await send(app.server, {}, { too: 'x'.repeat(4_600_000) });
    expect(anonymous.statusCode).toBe(401);

    const { headers } = await person();
    await confirm(app.server, headers, '00003');
    const noNotice = await send(
      app.server,
      headers,
      licenceSubmission({ noticeVersion: undefined }),
    );
    expect(noNotice.statusCode).toBe(400);
    expect(code(noNotice)).toBe('LICENCE_NOTICE_VERSION_REQUIRED');

    const badSelfie = {
      ...licenceSubmission(),
      selfie: { content_type: 'image/png', data_base64: 'AAAA' },
    };
    const refused = await send(app.server, headers, badSelfie);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'Check these fields: selfie.' },
    });

    const tooBig = await send(app.server, headers, {
      ...licenceSubmission(),
      pad: 'x'.repeat(4_600_000),
    });
    expect(tooBig.statusCode).toBe(413);
  });

  it('answers 503 with the reader disabled and never offers the path', async () => {
    const { headers } = await person(disabled);
    await confirm(disabled.server, headers, '00002');
    expect((await offer(disabled.server, headers)).offered).toBe(false);
    const refused = await send(disabled.server, headers);
    expect(refused.statusCode).toBe(503);
    expect(code(refused)).toBe('ID_VERIFICATION_UNAVAILABLE');
  });

  it('disputes only the caller own ALREADY_USED decline', async () => {
    const { headers } = await person();
    await confirm(app.server, headers, '00002');
    const first = (await send(app.server, headers)).json<{ review_id: string }>();
    const dispute = (id: string) =>
      send(app.server, headers, licenceSubmission(), `${LICENCE}/${id}/commands/dispute`);

    expect((await dispute(randomUUID())).statusCode).toBe(404);
    const notDeclined = await dispute(first.review_id);
    expect(notDeclined.statusCode).toBe(409);
    expect(code(notDeclined)).toBe('LICENCE_REVIEW_NOT_DISPUTABLE');

    await app.pool?.query(
      `UPDATE veteran_licence_reviews
          SET status = 'DECLINED', decline_reason = 'ALREADY_USED', decided_at = now(),
              front_key = NULL, back_key = NULL, selfie_key = NULL, read_result = NULL,
              licence_fingerprint = NULL, licence_fingerprint_key_id = NULL
        WHERE review_id = $1`,
      [first.review_id],
    );
    expect((await offer(app.server, headers)).review).toMatchObject({ disputable: true });
    const opened = await dispute(first.review_id);
    expect(opened.statusCode).toBe(202);
    expect(opened.json()).toMatchObject({ dispute_of_review_id: first.review_id });
  });
});
