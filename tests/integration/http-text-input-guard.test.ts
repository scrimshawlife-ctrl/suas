/**
 * U+0000 in any text field and over-deep settlement JSON answer 400 VALIDATION_FAILED, never
 * 500 (API.md §6): PostgreSQL refuses NUL in text and jsonb and overflows on very deep jsonb.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession, elevateSession } from '../../src/auth/index.js';
import {
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  publishConsentTemplateVersion,
} from '../../src/consent/index.js';
import { createUser, grantSuasAdmin } from '../../src/identity/index.js';
import { createDraft } from '../../src/intake/drafts.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_MODEL_INFERENCE_MODE: 'fake',
    }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

type Headers = Record<string, string>;
interface Reply {
  statusCode: number;
  body: string;
}

const NUL = 'before\u0000after';

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

/** One unsafe call with a fresh Idempotency-Key; a string payload is sent as raw JSON. */
function send(headers: Headers, method: string, url: string, payload?: unknown) {
  return app.server.inject({
    method: method as 'POST',
    url,
    headers: {
      ...headers,
      'idempotency-key': randomUUID(),
      ...(typeof payload === 'string' ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as string }),
  });
}

async function ok(reply: Promise<Reply>, label: string) {
  const r = await reply;
  if (r.statusCode >= 300) throw new Error(`${label}: ${String(r.statusCode)} ${r.body}`);
  return JSON.parse(r.body || '{}') as Record<string, unknown>;
}

/** "<status> <error code>", so one assertion shows every probe's outcome at once. */
function outcome(reply: Reply): string {
  const code = (JSON.parse(reply.body) as { error?: { code?: string } }).error?.code ?? '-';
  return `${String(reply.statusCode)} ${code}`;
}

const REJECTED = '400 VALIDATION_FAILED';

async function person(tenantId: string, label: string, verified: boolean) {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  if (verified) await markVerifiedVeteran(pool(), tenantId, user.userId);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return {
    userId: user.userId,
    sessionId: session.session.sessionId,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

/** A submitted FOOD request on the Veteran's case. */
async function submittedRequest(headers: Headers, caseId: string) {
  const created = await ok(
    send(headers, 'POST', `/api/v0/cases/${caseId}/service-requests`, {
      category: 'FOOD',
      details: { summary: 'groceries', meeting_place: 'library', timing: 'tonight' },
    }),
    'create request',
  );
  const id = created.service_request_id as string;
  await ok(send(headers, 'POST', `/api/v0/service-requests/${id}/commands/SUBMIT`, {}), 'submit');
  return id;
}

/**
 * Veteran A's case with one request accepted by P1 and one open, a draft and a published
 * consent template; ADM is an elevated SUAS admin. Each probe is valid apart from its NUL.
 */
async function world() {
  const tenantId = randomUUID();
  const A = await person(tenantId, 'vet-a', true);
  const P1 = await person(tenantId, 'helper', false);
  const ADM = await person(tenantId, 'admin', false);
  await grantSuasAdmin(pool(), ADM.userId, undefined);
  await elevateSession(pool(), ADM.sessionId);

  const caseA = (await ok(send(A.headers, 'POST', '/api/v0/cases'), 'case')).case_id as string;
  const accepted = await submittedRequest(A.headers, caseA);
  const open = await submittedRequest(A.headers, caseA);
  await ok(send(P1.headers, 'POST', `/api/v0/service-requests/${accepted}/accept`), 'accept');
  const draft = await createDraft(pool(), {
    draftId: randomUUID(),
    tenantId,
    userId: A.userId,
    intakeText: 'I need food tonight',
    fields: {
      category: 'FOOD',
      summary: 'groceries',
      timing: null,
      meetingPlace: 'library',
      destination: null,
    },
  });

  const templateKey = `guard-${randomUUID().slice(0, 8)}`;
  await createConsentTemplateVersion(pool(), { templateKey, version: 1, body: 'Template.' });
  const templateVersion = consentTemplateVersionKey(templateKey, 1);
  await publishConsentTemplateVersion(pool(), templateVersion, undefined);

  return { A, P1, ADM, caseA, accepted, open, draftId: draft.draftId, templateVersion };
}

/** A case P1 has activated whose only request was withdrawn: ready to resolve. */
async function resolvableCase() {
  const tenantId = randomUUID();
  const B = await person(tenantId, 'vet-b', true);
  const P1 = await person(tenantId, 'helper-b', false);
  const caseId = (await ok(send(B.headers, 'POST', '/api/v0/cases'), 'case')).case_id as string;
  const requestId = await submittedRequest(B.headers, caseId);
  await ok(send(P1.headers, 'POST', `/api/v0/service-requests/${requestId}/accept`), 'accept');
  await ok(send(P1.headers, 'POST', `/api/v0/cases/${caseId}/commands/activate`, {}), 'activate');
  await ok(
    send(B.headers, 'POST', `/api/v0/service-requests/${requestId}/commands/CANCEL`, {
      reason: 'withdrawn',
    }),
    'cancel',
  );
  return { caseId, P1 };
}

const deepObject = (depth: number) => '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);

describe('U+0000 in free text', () => {
  it('answers 400 VALIDATION_FAILED on every text-accepting route', async () => {
    const w = await world();
    const { A, P1, ADM } = w;
    const probes: [string, Headers, string, string, unknown][] = [
      [
        'chat body',
        A.headers,
        'POST',
        `/api/v0/service-requests/${w.accepted}/chat/messages`,
        { body: NUL },
      ],
      ['display_name', A.headers, 'PUT', '/api/v0/veterans/me/profile', { display_name: NUL }],
      [
        'request edit summary',
        A.headers,
        'POST',
        `/api/v0/service-requests/${w.open}/commands/edit`,
        { summary: NUL },
      ],
      [
        'create request details (jsonb)',
        A.headers,
        'POST',
        `/api/v0/cases/${w.caseA}/service-requests`,
        { category: 'FOOD', details: { summary: NUL, meeting_place: 'x' } },
      ],
      [
        'plain request form',
        A.headers,
        'POST',
        '/api/v0/service-requests',
        { category: 'FOOD', summary: NUL, meeting_place: 'x' },
      ],
      ['draft PATCH', A.headers, 'PATCH', `/api/v0/intake/drafts/${w.draftId}`, { summary: NUL }],
      [
        'trusted contact label',
        A.headers,
        'POST',
        '/api/v0/trusted-contacts',
        { relationship_label: NUL, invite_email: syntheticEmail(`tc-${randomUUID().slice(0, 6)}`) },
      ],
      [
        'contact note',
        P1.headers,
        'POST',
        `/api/v0/cases/${w.caseA}/commands/log-contact-attempt`,
        { channel: 'PHONE', note: NUL },
      ],
      [
        'case escalate reason',
        P1.headers,
        'POST',
        `/api/v0/cases/${w.caseA}/commands/escalate`,
        { reason: NUL },
      ],
      [
        'request release reason',
        P1.headers,
        'POST',
        `/api/v0/service-requests/${w.accepted}/commands/release`,
        { reason: NUL },
      ],
      [
        'request escalate reason',
        P1.headers,
        'POST',
        `/api/v0/service-requests/${w.accepted}/commands/escalate`,
        { reason: NUL },
      ],
      [
        'consent purpose',
        A.headers,
        'POST',
        '/api/v0/consents',
        {
          permission: 'can_receive',
          scope: 'RED',
          purpose: NUL,
          grantee_type: 'TRUSTED_CONTACT',
          grantee_id: randomUUID(),
          consent_template_version: w.templateVersion,
        },
      ],
      [
        'auth destination (unauthenticated)',
        {},
        'POST',
        '/api/v0/auth/challenges',
        { destination: `a${NUL}@example.invalid`, method: 'EMAIL_OTP' },
      ],
      [
        'admin consent template body',
        ADM.headers,
        'POST',
        '/api/v0/admin/consent-templates',
        { template_key: `nul-${randomUUID().slice(0, 6)}`, body: NUL },
      ],
    ];
    const outcomes: Record<string, string> = {};
    for (const [label, headers, method, url, payload] of probes) {
      outcomes[label] = outcome(await send(headers, method, url, payload));
    }
    expect(outcomes).toEqual(Object.fromEntries(probes.map(([label]) => [label, REJECTED])));
  });

  it('keeps accepting ordinary unicode and emoji', async () => {
    const w = await world();
    const sent = await send(
      w.A.headers,
      'POST',
      `/api/v0/service-requests/${w.accepted}/chat/messages`,
      { body: 'Thank you \u{1F64F} — très bien, 谢谢' },
    );
    expect(sent.statusCode).toBe(201);
  });

  it('keeps answering 400 for a deep JSON body into chat', async () => {
    const w = await world();
    const reply = await send(
      w.A.headers,
      'POST',
      `/api/v0/service-requests/${w.accepted}/chat/messages`,
      deepObject(20_000),
    );
    expect(outcome(reply)).toBe(REJECTED);
  });
});

describe('settlement content on POST /cases/:id/commands/resolve', () => {
  it('answers 400 for U+0000 in keys or values and for over-deep content, then still resolves', async () => {
    const { caseId, P1 } = await resolvableCase();
    const url = `/api/v0/cases/${caseId}/commands/resolve`;
    const settlement = (requested: string) =>
      `{"requested":${requested},"occurred":{},"fulfilled":{},"unresolved":{}}`;

    const outcomes = {
      'NUL in value': outcome(
        await send(P1.headers, 'POST', url, settlement(JSON.stringify({ k: NUL }))),
      ),
      'NUL in key': outcome(
        await send(P1.headers, 'POST', url, settlement(JSON.stringify({ [NUL]: 1 }))),
      ),
      'depth 20000': outcome(await send(P1.headers, 'POST', url, settlement(deepObject(20_000)))),
      'depth 40': outcome(await send(P1.headers, 'POST', url, settlement(deepObject(40)))),
    };
    expect(outcomes).toEqual({
      'NUL in value': REJECTED,
      'NUL in key': REJECTED,
      'depth 20000': REJECTED,
      'depth 40': REJECTED,
    });

    // A realistic reference-shaped settlement (SETTLEMENT.md §2) still resolves.
    const resolved = await send(P1.headers, 'POST', url, {
      requested: { service_requests: [{ id: randomUUID(), status: 'CANCELLED' }] },
      occurred: { contact_attempts: [{ channel: 'PHONE', outcome: { reached: false } }] },
      fulfilled: { fulfillments: [] },
      unresolved: { notes: 'none' },
    });
    expect(resolved.statusCode).toBe(200);
  });
});
