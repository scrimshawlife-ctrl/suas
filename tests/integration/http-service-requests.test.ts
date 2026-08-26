/**
 * Service Request JSON reads (requires PostgreSQL).
 *
 * SUAS-specs DISPATCH.md §1 / §4; API.md §4.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createServiceRequest, findNonClosedCase } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { createUser } from '../../src/identity/index.js';
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

describe('GET /api/v0/cases/:caseId/service-requests', () => {
  it('lists service requests for the veteran owner', async () => {
    const { pool, tenantId, user, headers, supportCase } = await openRedCase();
    const created = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'FOOD',
        details: {},
        createdBy: user.userId,
        actorType: 'VETERAN',
      }),
    );
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service_requests).toEqual([
      {
        service_request_id: created.serviceRequestId,
        case_id: supportCase.caseId,
        category: 'FOOD',
        status: created.status,
      },
    ]);
  });

  it('hides another tenant case', async () => {
    const { supportCase } = await openRedCase();
    const stranger = await openRedCase();
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: stranger.headers,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/v0/service-requests/:id', () => {
  it('returns one owned service request and 404s foreign ids', async () => {
    const { pool, tenantId, user, headers, supportCase } = await openRedCase();
    const created = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'TRANSPORTATION',
        details: {},
        createdBy: user.userId,
        actorType: 'VETERAN',
      }),
    );
    const ok = await app.server.inject({
      method: 'GET',
      url: `/api/v0/service-requests/${created.serviceRequestId}`,
      headers,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      service_request_id: created.serviceRequestId,
      category: 'TRANSPORTATION',
    });

    const other = await openRedCase();
    const leak = await app.server.inject({
      method: 'GET',
      url: `/api/v0/service-requests/${created.serviceRequestId}`,
      headers: other.headers,
    });
    expect(leak.statusCode).toBe(404);
  });
});
