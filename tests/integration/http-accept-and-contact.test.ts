/**
 * Trusted-contact accept + responder contact-log commands.
 *
 * TRUSTED_CIRCLE.md §3.4; RESPONDER_WORKFLOWS.md §2 / §7; API.md §4 / §7.
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
  return { responder, headers: await bearer(tenantId, responder.userId) };
}

describe('POST /api/v0/trusted-contacts/:id/commands/accept', () => {
  it('lets the invitee accept and binds contact_user_id', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const invitee = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`buddy-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const veteranHeaders = await bearer(tenantId, veteran.userId);
    const inviteeHeaders = await bearer(tenantId, invitee.userId);

    const invited = await app.server.inject({
      method: 'POST',
      url: '/api/v0/trusted-contacts',
      headers: veteranHeaders,
      payload: {
        relationship_label: 'Battle buddy',
        invite_email: invitee.email,
      },
    });
    expect(invited.statusCode).toBe(201);
    const contactId = invited.json().trusted_contact_id as string;
    expect(invited.json().status).toBe('INVITED');

    const selfAccept = await app.server.inject({
      method: 'POST',
      url: `/api/v0/trusted-contacts/${contactId}/commands/accept`,
      headers: {
        ...veteranHeaders,
        'idempotency-key': `accept-self-${randomUUID()}`,
      },
    });
    expect(selfAccept.statusCode).toBe(404);

    const accepted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/trusted-contacts/${contactId}/commands/accept`,
      headers: {
        ...inviteeHeaders,
        'idempotency-key': `accept-${randomUUID()}`,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      trusted_contact_id: contactId,
      status: 'ACCEPTED',
      contact_user_id: invitee.userId,
      replayed: false,
    });
  });

  it('hides accept across tenants', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const veteran = await createUser(pool, {
      tenantId: tenantA,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const stranger = await createUser(pool, {
      tenantId: tenantB,
      email: syntheticEmail(`str-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const invited = await app.server.inject({
      method: 'POST',
      url: '/api/v0/trusted-contacts',
      headers: await bearer(tenantA, veteran.userId),
      payload: {
        relationship_label: 'Private',
        invite_email: syntheticEmail(`x-${randomUUID().slice(0, 8)}`),
      },
    });
    expect(invited.statusCode).toBe(201);
    const contactId = invited.json().trusted_contact_id as string;
    const leak = await app.server.inject({
      method: 'POST',
      url: `/api/v0/trusted-contacts/${contactId}/commands/accept`,
      headers: {
        ...(await bearer(tenantB, stranger.userId)),
        'idempotency-key': `accept-leak-${randomUUID()}`,
      },
    });
    expect(leak.statusCode).toBe(404);
  });
});

describe('Contact log commands', () => {
  it('records attempt and complete-contact after claim', async () => {
    const { tenantId, supportCase } = await openRedCase();
    const { headers } = await responderFor(tenantId);
    const claimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/claim`,
      headers,
    });
    expect(claimed.statusCode).toBe(200);

    const attemptKey = `contact-attempt-${randomUUID()}`;
    const attempt = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/log-contact-attempt`,
      headers: { ...headers, 'idempotency-key': attemptKey },
      payload: { channel: 'PHONE' },
    });
    expect(attempt.statusCode).toBe(201);
    expect(attempt.json()).toMatchObject({
      case_id: supportCase.caseId,
      channel: 'PHONE',
      outcome: 'PENDING',
      deduplicated: false,
      replayed: false,
    });

    const replay = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/log-contact-attempt`,
      headers: { ...headers, 'idempotency-key': attemptKey },
      payload: { channel: 'PHONE' },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().contact_attempt_id).toBe(attempt.json().contact_attempt_id);

    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/complete-contact`,
      headers: { ...headers, 'idempotency-key': `contact-complete-${randomUUID()}` },
      payload: { channel: 'PHONE', outcome: 'REACHED' },
    });
    expect(completed.statusCode).toBe(201);
    expect(completed.json()).toMatchObject({
      channel: 'PHONE',
      outcome: 'REACHED',
    });

    const listed = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/contact-attempts`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().contact_attempts.length).toBeGreaterThanOrEqual(2);
  });

  it('forbids contact log without assignment and hides foreign cases', async () => {
    const a = await openRedCase();
    const { headers } = await responderFor(a.tenantId);
    const unclaimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/commands/log-contact-attempt`,
      headers: { ...headers, 'idempotency-key': `no-assign-${randomUUID()}` },
      payload: { channel: 'SMS' },
    });
    expect(unclaimed.statusCode).toBeGreaterThanOrEqual(400);

    const b = await openRedCase();
    const foreign = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/complete-contact`,
      headers: { ...headers, 'idempotency-key': `foreign-${randomUUID()}` },
      payload: { channel: 'EMAIL', outcome: 'NO_ANSWER' },
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('POST /api/v0/cases/:id/commands/assign', () => {
  it('lets an org admin assign a responder', async () => {
    const { pool, tenantId, supportCase } = await openRedCase();
    const org = await createOrganization(pool, {
      tenantId,
      name: `Admin Org ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const admin = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`admin-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await createMembership(pool, {
      tenantId,
      organizationId: org.organizationId,
      userId: admin.userId,
      role: 'ORG_ADMIN',
      status: 'ACTIVE',
    });
    const { responder } = await responderFor(tenantId);
    const assigned = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/assign`,
      headers: {
        ...(await bearer(tenantId, admin.userId)),
        'idempotency-key': `assign-${randomUUID()}`,
      },
      payload: { responder_user_id: responder.userId },
    });
    expect(assigned.statusCode).toBe(200);
    expect(assigned.json()).toMatchObject({
      case_id: supportCase.caseId,
      responder_user_id: responder.userId,
      replayed: false,
    });
  });
});
