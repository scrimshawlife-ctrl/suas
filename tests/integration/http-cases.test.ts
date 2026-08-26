/**
 * Unassigned queue and claim (requires PostgreSQL).
 *
 * SUAS-specs RESPONDER_WORKFLOWS.md §2 / §4; API.md §8.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
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

async function completeRedCheckIn() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await ensurePublishedQv001(pool, veteran.userId);
  const veteranHeaders = await bearer(tenantId, veteran.userId);
  const started = await app.server.inject({
    method: 'POST',
    url: '/api/v0/check-ins',
    headers: veteranHeaders,
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
      headers: veteranHeaders,
      payload: { question_id: question.question_id, answer_option_id: option.answer_option_id },
    });
    expect(saved.statusCode).toBe(200);
  }
  const completed = await app.server.inject({
    method: 'POST',
    url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
    headers: veteranHeaders,
  });
  expect(completed.statusCode).toBe(200);
  const result: { support_case: { case_id: string } | null } = completed.json();
  expect(result.support_case?.case_id).toBeDefined();
  return { tenantId, veteran, caseId: result.support_case?.case_id ?? '', veteranHeaders };
}

async function responderOn(tenantId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`resp-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const org = await createOrganization(pool, {
    tenantId,
    name: 'Example QRF',
    status: 'ACTIVE',
  });
  await createMembership(pool, {
    tenantId,
    userId: user.userId,
    organizationId: org.organizationId,
    role: 'RESPONDER',
    status: 'ACTIVE',
  });
  return { user, headers: await bearer(tenantId, user.userId) };
}

describe('GET /api/v0/cases', () => {
  it('hides the unassigned queue from a veteran', async () => {
    const { tenantId, veteranHeaders } = await completeRedCheckIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned',
      headers: veteranHeaders,
    });
    expect(response.statusCode).toBe(403);
    expect(tenantId).toBeDefined();
  });

  it('lists a RED Check-In case as unassigned and lets a responder claim it', async () => {
    const { tenantId, caseId } = await completeRedCheckIn();
    const responder = await responderOn(tenantId);
    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned',
      headers: responder.headers,
    });
    expect(listed.statusCode).toBe(200);
    const page: { cases: { case_id: string; priority_signal_level: string | null }[] } =
      listed.json();
    expect(page.cases.some((entry) => entry.case_id === caseId)).toBe(true);
    expect(page.cases.find((entry) => entry.case_id === caseId)?.priority_signal_level).toBe('RED');

    const claimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/claim`,
      headers: responder.headers,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().status).toBe('ASSIGNED');

    const mine = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=mine',
      headers: responder.headers,
    });
    const minePage: { cases: { case_id: string }[] } = mine.json();
    expect(minePage.cases.some((entry) => entry.case_id === caseId)).toBe(true);

    const dashboard = await app.server.inject({
      method: 'GET',
      url: '/app/responder',
      headers: responder.headers,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('Unassigned');
    expect(dashboard.body).toContain(caseId);
  });
});
