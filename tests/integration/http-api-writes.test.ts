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
import { createMembership, createOrganization, createUser } from '../../src/identity/index.js';
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

async function openRedCase() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
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

async function responderFor(tenantId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const org = await createOrganization(pool, {
    tenantId,
    name: `Org ${randomUUID().slice(0, 8)}`,
    status: 'ACTIVE',
  });
  const responder = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`resp-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await createMembership(pool, {
    tenantId,
    organizationId: org.organizationId,
    userId: responder.userId,
    role: 'RESPONDER',
    status: 'ACTIVE',
  });
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: responder.userId,
  });
  return {
    responder,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

describe('Service Request create + SUBMIT', () => {
  it('creates and submits for the veteran owner with idempotent replay', async () => {
    const { headers, supportCase } = await openRedCase();
    const key = `sr-create-${randomUUID()}`;
    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: { ...headers, 'idempotency-key': key },
      payload: { category: 'FOOD' },
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
      payload: { category: 'FOOD' },
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
      payload: { category: 'SHELTER' },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('Follow-Ups', () => {
  it('lets a responder create and complete a follow-up', async () => {
    const { tenantId, supportCase } = await openRedCase();
    const { responder, headers } = await responderFor(tenantId);
    const dueAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/v0/follow-ups',
      headers: { ...headers, 'idempotency-key': `fu-${randomUUID()}` },
      payload: {
        case_id: supportCase.caseId,
        due_at: dueAt,
        responsible_type: 'RESPONDER',
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

  it('forbids veterans from creating follow-ups', async () => {
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
