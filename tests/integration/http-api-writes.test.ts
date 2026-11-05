/**
 * Released write surfaces: service-request create/submit, follow-ups, notifications.
 *
 * SUAS-specs APIS.md; DISPATCH.md; FOLLOWUP.md; NOTIFICATIONS.md; API.md §4 / §7.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { findNonClosedCase } from '../../src/coordination/index.js';
import { createUser } from '../../src/identity/index.js';
import { ensurePublishedQv001 } from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { createVerifiedUser } from '../helpers/verified-veteran.js';

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

async function openRedCase() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createVerifiedUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  await ensurePublishedQv001(pool, user.userId);
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  const headers = { authorization: `Bearer ${session.credential}` };
  const started = await app.server.inject({ method: 'POST', url: '/api/v0/check-ins', headers });
  expect(started.statusCode).toBe(201);
  const checkIn: { check_in_id: string; questions: QuestionJson[] } = started.json();
  for (const question of checkIn.questions) {
    const optionKey =
      question.question_key === 'safe_now' ? 'NO_IMMEDIATE_HELP' : A0[question.question_key];
    if (optionKey === undefined) continue;
    const option = question.options.find((entry) => entry.option_key === optionKey);
    if (option === undefined) throw new Error(`missing ${optionKey}`);
    const saved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${checkIn.check_in_id}/responses`,
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
    url: `/api/v0/check-ins/${checkIn.check_in_id}/commands/complete`,
    headers,
  });
  expect(completed.statusCode).toBe(200);
  const supportCase = await findNonClosedCase(pool, tenantId, user.userId);
  if (supportCase === undefined) throw new Error('expected RED case');
  return { pool, tenantId, user, headers, supportCase };
}

/** A signed-in person in the launch county who can accept requests. */
async function accepterFor(tenantId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const accepter = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`acc-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: accepter.userId,
  });
  return {
    accepter,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

/** The accepter takes the case by accepting the Veteran's submitted request. */
async function acceptRequest(headers: Record<string, string>, srId: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${srId}/accept`,
    headers,
  });
}

describe('Service Request create + SUBMIT', () => {
  it('creates and submits for the veteran owner with idempotent replay', async () => {
    const { headers, supportCase } = await openRedCase();
    const key = `sr-create-${randomUUID()}`;
    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    expect(created.statusCode).toBe(201);
    const srId = created.json().service_request_id as string;
    expect(created.json()).toMatchObject({
      case_id: supportCase.caseId,
      category: 'FOOD',
      status: 'CREATED',
      replayed: false,
    });

    const replay = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      service_request_id: srId,
      replayed: true,
    });

    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${srId}/commands/SUBMIT`,
      headers: { ...headers, 'idempotency-key': `sr-submit-${randomUUID()}` },
      payload: {},
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({
      service_request_id: srId,
      status: 'SUBMITTED',
    });
  });

  it('hides create against another tenant case', async () => {
    const a = await openRedCase();
    const b = await openRedCase();
    const response = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/service-requests`,
      headers: { ...b.headers, 'idempotency-key': `sr-leak-${randomUUID()}` },
      payload: { category: 'SHELTER', details: { meeting_place: 'Main Street library' } },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('DISPATCH.md §4 — accepter commands need the person who accepted', () => {
  async function command(
    srId: string,
    name: string,
    headers: Record<string, string>,
  ): Promise<{ statusCode: number; json: () => { status?: string; error?: { code: string } } }> {
    return app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${srId}/commands/${name}`,
      headers: { ...headers, 'idempotency-key': `sr-${name}-${randomUUID()}` },
      payload: {},
    });
  }

  async function submittedRequest() {
    const opened = await openRedCase();
    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${opened.supportCase.caseId}/service-requests`,
      headers: { ...opened.headers, 'idempotency-key': `sr-create-${randomUUID()}` },
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    expect(created.statusCode).toBe(201);
    const srId = created.json().service_request_id as string;
    expect((await command(srId, 'SUBMIT', opened.headers)).statusCode).toBe(200);
    return { ...opened, srId };
  }

  it('refuses someone who did not accept and leaves the request unchanged', async () => {
    const { tenantId, srId, headers } = await submittedRequest();
    const outsider = await accepterFor(tenantId);
    const refused = await command(srId, 'TRIAGE', outsider.headers);
    // A person with no relationship to the request cannot tell it exists.
    expect(refused.statusCode).toBe(404);
    expect(refused.json().error?.code).toBe('NOT_FOUND');
    const read = await app.server.inject({
      method: 'GET',
      url: `/api/v0/service-requests/${srId}`,
      headers,
    });
    expect(read.json()).toMatchObject({ status: 'SUBMITTED' });
  });

  it('lets the person who accepted the request run the command', async () => {
    const { tenantId, srId } = await submittedRequest();
    const assigned = await accepterFor(tenantId);
    expect((await acceptRequest(assigned.headers, srId)).statusCode).toBe(200);
    // Accepting moved the request to ACCEPTED, so the accepter's next command is START.
    const started = await command(srId, 'START', assigned.headers);
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: 'IN_PROGRESS' });
  });

  it('keeps SUBMIT with the requester, even for a request the accepter created', async () => {
    const { tenantId, supportCase, headers } = await openRedCase();
    // The accepter needs a submitted request to accept, then creates another of their own.
    const first = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: { ...headers, 'idempotency-key': `sr-create-${randomUUID()}` },
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    const firstId = first.json().service_request_id as string;
    expect((await command(firstId, 'SUBMIT', headers)).statusCode).toBe(200);
    const creator = await accepterFor(tenantId);
    const other = await accepterFor(tenantId);
    expect((await acceptRequest(creator.headers, firstId)).statusCode).toBe(200);

    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: { ...creator.headers, 'idempotency-key': `sr-create-${randomUUID()}` },
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    expect(created.statusCode).toBe(201);
    const srId = created.json().service_request_id as string;
    expect((await command(srId, 'SUBMIT', other.headers)).statusCode).toBe(404);
    // The accepter created it, but submitting is the requester's act.
    expect((await command(srId, 'SUBMIT', creator.headers)).statusCode).toBe(403);
    const submitted = await command(srId, 'SUBMIT', headers);
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ status: 'SUBMITTED' });
  });
});

describe('Follow-Ups', () => {
  it('lets the accepter create and complete a follow-up', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase();
    const { accepter: responder, headers } = await accepterFor(tenantId);
    const sr = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: { ...veteranHeaders, 'idempotency-key': `sr-${randomUUID()}` },
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    const srId = sr.json().service_request_id as string;
    await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${srId}/commands/SUBMIT`,
      headers: { ...veteranHeaders, 'idempotency-key': `sub-${randomUUID()}` },
      payload: {},
    });
    expect((await acceptRequest(headers, srId)).statusCode).toBe(200);
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/v0/follow-ups',
      headers: { ...headers, 'idempotency-key': `fu-${randomUUID()}` },
      payload: {
        case_id: supportCase.caseId,
        due_at: dueAt,
        responsible_type: 'USER',
        responsible_id: responder.userId,
        resolution_disposition: 'CARRIED_FORWARD',
      },
    });
    expect(created.statusCode).toBe(201);
    const followUpId = created.json().follow_up_id as string;
    expect(created.json()).toMatchObject({
      case_id: supportCase.caseId,
      status: 'SCHEDULED',
      responsible_id: responder.userId,
    });

    const listed = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/follow-ups`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    const listedBody: { follow_ups: { follow_up_id: string }[] } = listed.json();
    expect(listedBody.follow_ups.map((row) => row.follow_up_id)).toEqual([followUpId]);

    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/follow-ups/${followUpId}/commands/complete`,
      headers: { ...headers, 'idempotency-key': `fu-complete-${randomUUID()}` },
    });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      follow_up_id: followUpId,
      status: 'COMPLETED',
      already_completed: false,
    });
  });

  it('forbids the requester from creating follow-ups', async () => {
    const { headers, supportCase, user } = await openRedCase();
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/follow-ups',
      headers: { ...headers, 'idempotency-key': `fu-vet-${randomUUID()}` },
      payload: {
        case_id: supportCase.caseId,
        due_at: new Date(Date.now() + 3_600_000).toISOString(),
        responsible_type: 'VETERAN',
        responsible_id: user.userId,
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('Notifications', () => {
  it('lists an empty inbox and sets channel preferences', async () => {
    const { headers } = await openRedCase();
    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/notifications',
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({ notifications: [], limit: 50 });
    expect(listed.body).not.toContain('destination');
    expect(listed.body).not.toContain('consent_basis');

    const preferred = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/notifications/preferences',
      headers,
      payload: { channel: 'SMS', enabled: false },
    });
    expect(preferred.statusCode).toBe(200);
    expect(preferred.json()).toEqual({ channel: 'SMS', enabled: false });
  });

  it('requires authentication', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/notifications',
    });
    expect(response.statusCode).toBe(401);
  });
});
