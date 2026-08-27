/**
 * Released CASES.md §4 commands over /api/v0 (beyond claim/assign/resolve).
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

async function bearer(tenantId: string, userId: string, organizationId?: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId,
    ...(organizationId !== undefined ? { organizationId } : {}),
  });
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
  return { pool, tenantId, veteran, supportCase };
}

async function membership(
  tenantId: string,
  role: 'RESPONDER' | 'ORG_ADMIN',
  organizationId?: string,
): Promise<{ userId: string; organizationId: string; headers: Record<string, string> }> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const org =
    organizationId === undefined
      ? await createOrganization(pool, {
          tenantId,
          name: `Org ${randomUUID().slice(0, 8)}`,
          status: 'ACTIVE',
        })
      : { organizationId };
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`${role.toLowerCase()}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await createMembership(pool, {
    tenantId,
    organizationId: org.organizationId,
    userId: user.userId,
    role,
    status: 'ACTIVE',
  });
  return {
    userId: user.userId,
    organizationId: org.organizationId,
    headers: await bearer(tenantId, user.userId, org.organizationId),
  };
}

function settlementPayload(responderId: string) {
  return {
    requested: { service_requests: [] },
    occurred: { contact_attempts: 1 },
    fulfilled: { fulfillments: [] },
    unresolved: { notes: 'none' },
    authored_by: responderId,
    responder_confirmed_by: responderId,
  };
}

describe('CASE_COMMANDS over /api/v0', () => {
  it('runs claim → activate → escalate → move-to-followup → resume → resolve → close → reopen', async () => {
    const { tenantId, supportCase } = await openRedCase();
    const responder = await membership(tenantId, 'RESPONDER');
    const admin = await membership(tenantId, 'ORG_ADMIN', responder.organizationId);
    const caseId = supportCase.caseId;

    const claimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/claim`,
      headers: responder.headers,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().status).toBe('ASSIGNED');

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

  it('triages OPEN, forbids cross-tenant activate, and requires Idempotency-Key', async () => {
    const a = await openRedCase();
    const b = await openRedCase();
    const responderA = await membership(a.tenantId, 'RESPONDER');
    const responderB = await membership(b.tenantId, 'RESPONDER');

    const triaged = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/commands/triage`,
      headers: { ...responderA.headers, 'idempotency-key': `triage-${randomUUID()}` },
      payload: {},
    });
    expect(triaged.statusCode).toBe(200);
    expect(triaged.json().status).toBe('TRIAGED');

    const claimedB = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/claim`,
      headers: responderB.headers,
    });
    expect(claimedB.statusCode).toBe(200);

    const activateMissing = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/activate`,
      headers: responderB.headers,
      payload: {},
    });
    expect(activateMissing.statusCode).toBe(400);

    const foreign = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/activate`,
      headers: { ...responderA.headers, 'idempotency-key': `xtenant-${randomUUID()}` },
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
  });
});
