/**
 * LOCAL-only dev hook for the fake model (requires PostgreSQL).
 *
 * `POST /api/v0/dev/model-inference/turns` feeds the scripted fake so the Intake
 * Assistant can run in a local web app. It exists only in the LOCAL environment class,
 * and only does anything when the port is the scripted fake.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { openCase, createServiceRequest } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

const URL = '/api/v0/dev/model-inference/turns';
const TURNS = {
  turns: [
    {
      ok: true,
      text: '',
      toolCalls: [
        {
          id: 'd1',
          name: 'draft_service_request',
          input: { category: 'PEER_SUPPORT', summary: 'Someone to talk to' },
        },
      ],
    },
    { ok: true, text: 'I drafted it.', toolCalls: [] },
  ],
};

const apps: StartedApp[] = [];

async function start(overrides: Record<string, string>): Promise<StartedApp> {
  const started = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      ...overrides,
    }),
    listen: false,
  });
  apps.push(started);
  return started;
}

afterAll(async () => {
  await Promise.all(apps.map((started) => started.close()));
});

describe('POST /api/v0/dev/model-inference/turns', () => {
  it('queues scripted turns so the Intake Assistant answers in LOCAL', async () => {
    const local = await start({ SUAS_ENV: 'LOCAL', SUAS_MODEL_INFERENCE_MODE: 'fake' });
    const pool = local.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`dev-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await markVerifiedVeteran(pool, tenantId, user.userId);
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const headers = { authorization: `Bearer ${session.credential}` };

    // Empty queue: the fake reports unavailable, so the client is sent to the plain form.
    const before = await local.server.inject({
      method: 'POST',
      url: '/api/v0/intake/drafts',
      headers,
      payload: { text: 'I want to talk to someone.' },
    });
    expect(before.json().outcome).toBe('FALLBACK_FORM');

    const queued = await local.server.inject({ method: 'POST', url: URL, payload: TURNS });
    expect(queued.statusCode).toBe(202);
    expect(queued.json()).toEqual({ queued: 2 });

    const after = await local.server.inject({
      method: 'POST',
      url: '/api/v0/intake/drafts',
      headers,
      payload: { text: 'I want to talk to someone.' },
    });
    expect(after.statusCode).toBe(201);
    expect(after.json().draft).toMatchObject({
      category: 'PEER_SUPPORT',
      summary: 'Someone to talk to',
    });
  });

  it('answers 409 in LOCAL when the model port is not the scripted fake', async () => {
    const local = await start({ SUAS_ENV: 'LOCAL', SUAS_MODEL_INFERENCE_MODE: 'disabled' });
    const response = await local.server.inject({ method: 'POST', url: URL, payload: TURNS });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DEV_MODEL_NOT_SCRIPTED');
  });

  it('is not registered outside LOCAL', async () => {
    const test = await start({ SUAS_MODEL_INFERENCE_MODE: 'fake' });
    const response = await test.server.inject({ method: 'POST', url: URL, payload: TURNS });
    expect(response.statusCode).toBe(404);
  });

  it('answers the simulate step with a clear 422 when the meeting place is missing', async () => {
    const local = await start({ SUAS_ENV: 'LOCAL' });
    const pool = local.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`sim-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const request = await withTransaction(pool, async (tx) => {
      const opened = await openCase(tx, {
        tenantId,
        veteranUserId: user.userId,
        actorType: 'VETERAN',
        actorId: user.userId,
      });
      return createServiceRequest(tx, {
        tenantId,
        caseId: opened.supportCase.caseId,
        category: 'FOOD',
        createdBy: user.userId,
        actorType: 'VETERAN',
      });
    });
    const response = await local.server.inject({
      method: 'POST',
      url: `/api/v0/dev/service-requests/${request.serviceRequestId}/simulate`,
      headers: { authorization: `Bearer ${session.credential}` },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.message).toContain('meeting_place');

    // A1-21: another signed-in user in the tenant who neither owns nor holds it gets 404.
    const stranger = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`sim-x-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const strangerSession = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: stranger.userId,
    });
    const refused = await local.server.inject({
      method: 'POST',
      url: `/api/v0/dev/service-requests/${request.serviceRequestId}/simulate`,
      headers: { authorization: `Bearer ${strangerSession.credential}` },
    });
    expect(refused.statusCode).toBe(404);
  });
});
