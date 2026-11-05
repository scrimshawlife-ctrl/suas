/**
 * Released CASES.md §4 commands over /api/v0 (beyond accept/resolve), for the person
 * who accepted a case and for SUAS System Administrators (V1_PROJECT_PLAN.md §2.1).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { findNonClosedCase } from '../../src/coordination/index.js';
import { createUser, grantSuasAdmin } from '../../src/identity/index.js';
import { ensurePublishedQv001 } from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl() }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

const A0: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};

interface QuestionJson {
  question_id: string;
  question_key: string;
  options: { answer_option_id: string; option_key: string }[];
}

async function bearer(tenantId: string, userId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId });
  return { authorization: `Bearer ${session.credential}` };
}

async function openRedCase() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  await ensurePublishedQv001(pool, veteran.userId);
  const headers = await bearer(tenantId, veteran.userId);
  const started = await app.server.inject({
    method: 'POST',
    url: '/api/v0/check-ins',
    headers,
  });
  expect(started.statusCode).toBe(201);
  const body: { check_in_id: string; questions: QuestionJson[] } = started.json();
  for (const question of body.questions) {
    const optionKey =
      question.question_key === 'safe_now' ? 'NO_IMMEDIATE_HELP' : A0[question.question_key];
    if (optionKey === undefined) continue;
    const option = question.options.find((entry) => entry.option_key === optionKey);
    if (option === undefined) throw new Error(`missing ${optionKey}`);
    const saved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/responses`,
      headers,
      payload: {
        question_id: question.question_id,
        answer_option_id: option.answer_option_id,
      },
    });
    expect(saved.statusCode).toBe(200);
  }
  const completed = await app.server.inject({
    method: 'POST',
    url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
    headers,
  });
  expect(completed.statusCode).toBe(200);
  const supportCase = await findNonClosedCase(pool, tenantId, veteran.userId);
  if (supportCase === undefined) throw new Error('expected RED case');
  return { pool, tenantId, veteran, headers, supportCase };
}

/** A signed-in person in the launch county. `admin` adds the SUAS System Administrator grant. */
async function person(
  tenantId: string,
  label: string,
  options: { admin?: boolean } = {},
): Promise<{ userId: string; headers: Record<string, string> }> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  if (options.admin === true) await grantSuasAdmin(pool, user.userId, undefined);
  return { userId: user.userId, headers: await bearer(tenantId, user.userId) };
}

/** The requester submits a request on their case, which puts it on the open list. */
async function submitRequest(headers: Record<string, string>, caseId: string): Promise<string> {
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${caseId}/service-requests`,
    headers: { ...headers, 'idempotency-key': `sr-${randomUUID()}` },
    payload: { category: 'FOOD' },
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().service_request_id;
  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/commands/SUBMIT`,
    headers: { ...headers, 'idempotency-key': `submit-${randomUUID()}` },
    payload: {},
  });
  expect(submitted.statusCode).toBe(200);
  return id;
}

function settlementPayload(accepterId: string) {
  return {
    requested: { service_requests: [] },
    occurred: { contact_attempts: 1 },
    fulfilled: { fulfillments: [] },
    unresolved: { notes: 'none' },
    authored_by: accepterId,
    accepted_by_user_id: accepterId,
  };
}

describe('CASE_COMMANDS over /api/v0', () => {
  it('runs claim → activate → escalate → move-to-followup → resume → resolve → close → reopen', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase();
    const responder = await person(tenantId, 'accepter');
    const admin = await person(tenantId, 'staff', { admin: true });
    const caseId = supportCase.caseId;
    const requestId = await submitRequest(veteranHeaders, caseId);

    const claimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/accept`,
      headers: responder.headers,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().case_status).toBe('ASSIGNED');

    const activated = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/activate`,
      headers: { ...responder.headers, 'idempotency-key': `act-${randomUUID()}` },
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ status: 'ACTIVE', replayed: false });

    const escalateKey = `esc-${randomUUID()}`;
    const escalated = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/escalate`,
      headers: { ...responder.headers, 'idempotency-key': escalateKey },
      payload: { reason: 'needs supervisor eyes' },
    });
    expect(escalated.statusCode).toBe(200);
    expect(escalated.json().status).toBe('ACTIVE');

    const escalateReplay = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/escalate`,
      headers: { ...responder.headers, 'idempotency-key': escalateKey },
      payload: { reason: 'needs supervisor eyes' },
    });
    expect(escalateReplay.statusCode).toBe(200);
    expect(escalateReplay.json().replayed).toBe(true);

    const followup = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/move-to-followup`,
      headers: { ...responder.headers, 'idempotency-key': `fu-${randomUUID()}` },
      payload: { reason: 'waiting on resource callback' },
    });
    expect(followup.statusCode).toBe(200);
    expect(followup.json().status).toBe('FOLLOWUP');

    const resumed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/resume-active`,
      headers: { ...responder.headers, 'idempotency-key': `resume-${randomUUID()}` },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe('ACTIVE');

    // A case cannot resolve while a request is still open (CASES.md §4, §7).
    const cancelled = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/commands/CANCEL`,
      headers: { ...veteranHeaders, 'idempotency-key': `cancel-${randomUUID()}` },
      payload: { reason: 'need met another way' },
    });
    expect(cancelled.statusCode).toBe(200);

    const resolved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/resolve`,
      headers: { ...responder.headers, 'idempotency-key': `resolve-${randomUUID()}` },
      payload: settlementPayload(responder.userId),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('RESOLVED');

    const closed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/close`,
      headers: { ...responder.headers, 'idempotency-key': `close-${randomUUID()}` },
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('CLOSED');

    const reopened = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/reopen`,
      headers: { ...admin.headers, 'idempotency-key': `reopen-${randomUUID()}` },
      payload: { reason: 'veteran reported recurrence' },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe('OPEN');
  });

  it('lets only SUAS System Administrators triage, and keeps other people out of a case', async () => {
    const a = await openRedCase();
    const b = await openRedCase();
    const staffA = await person(a.tenantId, 'staff', { admin: true });
    const accepterA = await person(a.tenantId, 'accepter');
    const accepterB = await person(b.tenantId, 'accepter');
    const requestB = await submitRequest(b.headers, b.supportCase.caseId);

    const forbidden = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/commands/triage`,
      headers: { ...accepterA.headers, 'idempotency-key': `triage-${randomUUID()}` },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const triaged = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/commands/triage`,
      headers: { ...staffA.headers, 'idempotency-key': `triage-${randomUUID()}` },
      payload: {},
    });
    expect(triaged.statusCode).toBe(200);
    expect(triaged.json().status).toBe('TRIAGED');

    const claimedB = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestB}/accept`,
      headers: accepterB.headers,
    });
    expect(claimedB.statusCode).toBe(200);

    const activateMissing = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/activate`,
      headers: accepterB.headers,
      payload: {},
    });
    expect(activateMissing.statusCode).toBe(400);

    // Someone who is neither the requester nor the accepter cannot tell the case exists.
    const foreign = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/activate`,
      headers: { ...accepterA.headers, 'idempotency-key': `xtenant-${randomUUID()}` },
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('CASES.md §5 item 5 — accept replay over /api/v0', () => {
  it('returns the original assignment to the holder and 409 to anyone else', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase();
    const accepter = await person(tenantId, 'accepter');
    const other = await person(tenantId, 'accepter-b');
    const requestId = await submitRequest(veteranHeaders, supportCase.caseId);
    const url = `/api/v0/service-requests/${requestId}/accept`;

    const first = await app.server.inject({ method: 'POST', url, headers: accepter.headers });
    expect(first.statusCode).toBe(200);
    const replay = await app.server.inject({ method: 'POST', url, headers: accepter.headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().assignment_id).toBe(first.json().assignment_id);
    expect(replay.json().case_status).toBe(first.json().case_status);

    const loser = await app.server.inject({ method: 'POST', url, headers: other.headers });
    expect(loser.statusCode).toBe(409);
  });
});
