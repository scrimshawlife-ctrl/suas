/**
 * U+0000 in any text field and over-deep settlement JSON answer 400 VALIDATION_FAILED, never
 * 500 (API.md §6): PostgreSQL refuses NUL in text and jsonb and overflows on very deep jsonb.
 */

import { randomUUID } from 'node:crypto';
import { connect, type AddressInfo } from 'node:net';
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
import { API_PREFIX } from '../../src/release/pins.js';
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
  return `${String(reply.statusCode)} ${errorCode(reply.body)}`;
}

/** The envelope's error code, or '-' for a body that is not one (an HTML page, a redirect). */
function errorCode(body: string): string {
  try {
    return (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? '-';
  } catch {
    return '-';
  }
}

const VALIDATION = 'VALIDATION_FAILED';
const REJECTED = `400 ${VALIDATION}`;

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

describe('U+0000 outside the JSON body', () => {
  /**
   * One raw HTTP/1.1 request; resolves with the status line and body. inject() hands headers
   * straight to Fastify, skipping Node's HTTP parser, so a header probe needs a real socket.
   */
  function rawRequest(port: number, head: string[], body: string) {
    return new Promise<{ status: string; body: string }>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          [...head, `content-length: ${String(Buffer.byteLength(body))}`, 'connection: close']
            .map((line) => `${line}\r\n`)
            .join('') + `\r\n${body}`,
        );
      });
      let received = '';
      socket.on('data', (chunk: Buffer) => (received += chunk.toString('utf8')));
      socket.on('close', () => {
        const [headPart = '', bodyPart = ''] = received.split('\r\n\r\n');
        resolve({ status: headPart.split('\r\n')[0] ?? '', body: bodyPart });
      });
      socket.on('error', reject);
    });
  }

  it('refuses NUL in any header the API reads at the HTTP parser, before a handler runs', async () => {
    const w = await world();
    await app.server.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.server.address() as AddressInfo;
    const url = `${API_PREFIX}/service-requests/${w.accepted}/chat/messages`;
    const headers = (overrides: Headers) =>
      Object.entries({
        host: 'localhost',
        authorization: w.A.headers.authorization ?? '',
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
        ...overrides,
      }).map(([name, value]) => `${name}: ${value}`);
    const post = (label: string, overrides: Headers) =>
      rawRequest(
        port,
        [`POST ${url} HTTP/1.1`, ...headers(overrides)],
        JSON.stringify({ body: label }),
      );

    const probes: Headers = {
      authorization: `${w.A.headers.authorization ?? ''}\u0000`,
      cookie: 'suas_session=a\u0000b',
      'idempotency-key': `${randomUUID()}\u0000`,
      origin: 'http://localhost\u0000',
      'x-request-id': 'a\u0000b',
      'content-type': 'application/json\u0000',
    };
    const outcomes: Record<string, string> = {};
    for (const [name, value] of Object.entries(probes)) {
      const reply = await post(`probe ${name}`, { [name]: value });
      outcomes[name] = `${reply.status} ${errorCode(reply.body)}`;
    }
    expect(outcomes).toEqual(
      Object.fromEntries(
        Object.keys(probes).map((name) => [name, `HTTP/1.1 400 Bad Request ${VALIDATION}`]),
      ),
    );

    // The same request without the NUL is stored, and none of the probes were.
    expect((await post('control', {})).status).toBe('HTTP/1.1 201 Created');
    const listed = await app.server.inject({ method: 'GET', url, headers: w.A.headers });
    const bodies = (JSON.parse(listed.body) as { messages: { body: string }[] }).messages.map(
      (message) => message.body,
    );
    expect(bodies).toEqual(['control']);
  });

  it('answers 400 for NUL in a path or query parameter', async () => {
    const w = await world();
    const messages = `${API_PREFIX}/service-requests/${w.accepted}/chat/messages`;
    const publish = `${API_PREFIX}/admin/consent-templates/a%00b/commands/publish`;
    const outcomes = {
      'query value': outcome(await send(w.A.headers, 'GET', `${messages}?cursor=a%00b`)),
      'query key': outcome(await send(w.A.headers, 'GET', `${messages}?a%00b=1`)),
      'path parameter': outcome(await send(w.ADM.headers, 'POST', publish, {})),
      '/app form field': outcome(
        await app.server.inject({
          method: 'POST',
          url: '/app/admin/providers/routing',
          headers: { ...w.ADM.headers, 'content-type': 'application/x-www-form-urlencoded' },
          payload:
            'adapter_id=food-manual&capability=FOOD&coverage_counties=SANTA%00CLARA&routing_priority=1',
        }),
      ),
    };
    expect(outcomes).toEqual({
      'query value': REJECTED,
      'query key': REJECTED,
      'path parameter': REJECTED,
      '/app form field': REJECTED,
    });
  });

  /**
   * Every route in Fastify's route tree (printRoutes) as a full path and its methods. It is the
   * whole table, not just `/api/v0`, so a route under any prefix is held to the guard.
   */
  function registeredRoutes(): { path: string; methods: string[] }[] {
    const routes: { path: string; methods: string[] }[] = [];
    const parents: string[] = [];
    for (const line of app.server.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^([│ ]*)[├└]── (.+?)(?: \(([^)]+)\))?$/.exec(line);
      if (match === null) continue;
      const level = (match[1] ?? '').length / 4;
      const path = (parents[level - 1] ?? '') + (match[2] ?? '');
      parents[level] = path;
      if (match[3] !== undefined) routes.push({ path, methods: match[3].split(', ') });
    }
    return routes;
  }

  it('guards every registered route, under /api/v0 and /app alike', async () => {
    // A signed-in Veteran and a form body, so the onRequest gates of the licence routes
    // (session) and the /app sign-in routes (form media type) pass and the guard is reached.
    const { A } = await world();
    const routes = registeredRoutes();
    expect(routes.filter((route) => route.path.startsWith(API_PREFIX)).length).toBeGreaterThan(50);
    expect(routes.filter((route) => route.path.startsWith('/app')).length).toBeGreaterThan(20);

    const unguarded: string[] = [];
    for (const route of routes) {
      for (const method of route.methods.filter((m) => m !== 'HEAD' && m !== 'OPTIONS')) {
        const url = route.path.replace(/:[^/]+/g, randomUUID()).replace(/\*$/, 'x');
        const withBody = method !== 'GET' && method !== 'DELETE';
        const reply = await app.server.inject({
          method: method as 'GET',
          url: `${url}?probe=%00`,
          headers: {
            ...A.headers,
            'idempotency-key': randomUUID(),
            ...(withBody ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          },
          ...(withBody ? { payload: 'field=1' } : {}),
        });
        if (outcome(reply) !== REJECTED)
          unguarded.push(`${method} ${route.path} ${outcome(reply)}`);
      }
    }
    expect(unguarded).toEqual([]);
  });
});

describe('settlement content on POST /cases/:id/commands/resolve', () => {
  const settlement = (requested: string) =>
    `{"requested":${requested},"occurred":{},"fulfilled":{},"unresolved":{}}`;

  it('answers 400 for U+0000 anywhere, an array section or depth 17, then resolves at depth 16', async () => {
    const { caseId, P1 } = await resolvableCase();
    const url = `/api/v0/cases/${caseId}/commands/resolve`;
    const probe = async (requested: unknown) =>
      outcome(await send(P1.headers, 'POST', url, settlement(JSON.stringify(requested))));

    const outcomes = {
      'NUL in value': await probe({ k: NUL }),
      'NUL in key': await probe({ [NUL]: 1 }),
      'NUL in nested key': await probe({ a: { [`b${NUL}`]: 1 } }),
      'NUL in array element': await probe({ service_requests: ['ok', NUL] }),
      'lone NUL string': await probe({ k: '\u0000' }),
      'array section': await probe([{ id: randomUUID() }]),
      'depth 20000': outcome(await send(P1.headers, 'POST', url, settlement(deepObject(20_000)))),
      'depth 40': outcome(await send(P1.headers, 'POST', url, settlement(deepObject(40)))),
      'depth 17': outcome(await send(P1.headers, 'POST', url, settlement(deepObject(17)))),
    };
    expect(outcomes).toEqual(Object.fromEntries(Object.keys(outcomes).map((k) => [k, REJECTED])));

    const atLimit = await send(P1.headers, 'POST', url, settlement(deepObject(16)));
    expect(atLimit.statusCode).toBe(200);
  });

  it('resolves a reference-shaped settlement with arrays inside a section (SETTLEMENT.md §2)', async () => {
    const { caseId, P1 } = await resolvableCase();
    const resolved = await send(P1.headers, 'POST', `/api/v0/cases/${caseId}/commands/resolve`, {
      requested: { service_requests: [{ id: randomUUID(), status: 'CANCELLED' }] },
      occurred: { contact_attempts: [{ channel: 'PHONE', outcome: { reached: false } }] },
      fulfilled: { fulfillments: [] },
      unresolved: { notes: 'none' },
    });
    expect(resolved.statusCode).toBe(200);
  });

  it('answers 413 for a body over the 1 MiB limit before the NUL guard sees it', async () => {
    const { caseId, P1 } = await resolvableCase();
    const oversized = settlement(JSON.stringify({ k: NUL, pad: 'x'.repeat(1_048_576) }));
    const reply = await send(
      P1.headers,
      'POST',
      `/api/v0/cases/${caseId}/commands/resolve`,
      oversized,
    );
    expect(outcome(reply)).toBe(`413 ${VALIDATION}`);
  });
});
