/**
 * Chat assistance over HTTP (R18.7, contributor proposal, not released; requires PostgreSQL):
 * helper only, live and open requests only, crisis before the model, the hourly cap, no writes.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import type { ScriptedModelInference } from '../../src/inference/index.js';
import { appPool, createPerson, keyed, type Actor } from '../helpers/actors.js';
import { testDatabaseUrl, validEnv } from '../helpers/env.js';

let app: StartedApp;
let model: ScriptedModelInference;

const env = (mode: string) =>
  validEnv({
    SUAS_MIGRATIONS_MODE: 'apply',
    DATABASE_URL: testDatabaseUrl(),
    SUAS_MODEL_INFERENCE_MODE: 'fake',
    SUAS_CHAT_ASSIST_MODE: mode,
  });

beforeAll(async () => {
  app = await startApp({ env: env('enabled'), listen: false });
  model = app.modelInference as ScriptedModelInference;
});

afterAll(async () => {
  await app.close();
});

/** A FOOD request with a live thread between its requester and a helper, as chat.test.ts does. */
async function scenario(on: StartedApp = app) {
  const tenantId = randomUUID();
  const person = (label: string) => createPerson(on, { tenantId, label, verified: true });
  const requester = await person('requester');
  const helper = await person('helper');
  const stranger = await person('stranger');
  const opened = await on.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  const created = await on.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${opened.json().case_id as string}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD' },
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().service_request_id;
  const threadId = randomUUID();
  await appPool(on).query(
    `INSERT INTO chat_threads
       (chat_thread_id, tenant_id, service_request_id, requester_user_id, accepted_by_user_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [threadId, tenantId, id, requester.userId, helper.userId],
  );
  await appPool(on).query(
    `UPDATE service_requests SET accepted_by_user_id = $2
      WHERE tenant_id = $1 AND service_request_id = $3`,
    [tenantId, helper.userId, id],
  );
  return { tenantId, requester, helper, stranger, id, threadId };
}

function say(who: Actor, id: string, body: string, on: StartedApp = app) {
  return on.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/chat/messages`,
    headers: keyed(who),
    payload: { body },
  });
}

function assist(who: Actor, id: string, kind = 'SUGGEST_REPLY', on: StartedApp = app) {
  return on.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/chat/assist`,
    headers: who.headers,
    payload: { kind },
  });
}

const messageCount = async (threadId: string) =>
  (
    await appPool(app).query<{ n: number }>(
      `SELECT count(*)::int AS n FROM chat_messages WHERE chat_thread_id = $1`,
      [threadId],
    )
  ).rows[0]?.n;

const threadsOf = async (who: Actor, on: StartedApp = app) =>
  (
    await on.server.inject({ method: 'GET', url: '/api/v0/chat/threads', headers: who.headers })
  ).json().threads as { chat_assist_enabled: boolean }[];

describe('POST /service-requests/{id}/chat/assist', () => {
  it('gives the helper a suggestion and writes no message', async () => {
    const { requester, helper, id, threadId } = await scenario();
    await say(requester, id, 'Could you bring the groceries Friday?');
    await say(helper, id, 'Yes, Friday works.');
    const before = await messageCount(threadId);
    model.enqueue({ ok: true, text: 'Great, see you Friday.', toolCalls: [] });

    const response = await assist(helper, id);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ outcome: 'SUGGESTION', text: 'Great, see you Friday.' });
    // R18.6 (contributor's call, D-066): the guard report is for the eval, never the client.
    expect(response.json()).not.toHaveProperty('guard');
    const sent = model.requests().at(-1);
    expect(sent?.purpose).toBe('chat_assist');
    const parts = sent?.messages[0]?.parts.map((part) => (part.type === 'text' ? part.text : ''));
    expect(parts?.[1]).toMatch(/^Veteran:\n<message>\nCould you bring/);
    expect(parts?.[2]).toMatch(/^You:\n/);
    expect(await messageCount(threadId)).toBe(before);
    expect((await threadsOf(requester))[0]?.chat_assist_enabled).toBe(true);
    expect((await threadsOf(helper))[0]?.chat_assist_enabled).toBe(true);
  });

  it('refuses the requester (409), a stranger (404) and a released helper (404)', async () => {
    const { tenantId, requester, helper, stranger, id, threadId } = await scenario();
    const own = await assist(requester, id);
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('CHAT_ASSIST_HELPER_ONLY');
    expect((await assist(stranger, id)).statusCode).toBe(404);

    await appPool(app).query(
      `UPDATE chat_threads SET released_at = now() WHERE chat_thread_id = $1`,
      [threadId],
    );
    await appPool(app).query(
      `UPDATE service_requests SET accepted_by_user_id = NULL
        WHERE tenant_id = $1 AND service_request_id = $2`,
      [tenantId, id],
    );
    expect((await assist(helper, id)).statusCode).toBe(404);
    expect((await threadsOf(requester))[0]?.chat_assist_enabled).toBe(false);
  });

  it('refuses a request in a terminal status', async () => {
    const { tenantId, helper, id } = await scenario();
    await appPool(app).query(
      `UPDATE service_requests SET status = 'CANCELLED'
        WHERE tenant_id = $1 AND service_request_id = $2`,
      [tenantId, id],
    );
    const response = await assist(helper, id, 'CATCH_UP');
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CHAT_ASSIST_REQUEST_CLOSED');
  });

  it('answers crisis language from the Veteran without calling the model', async () => {
    const { requester, helper, id } = await scenario();
    await say(requester, id, 'Honestly I want to die');
    const calls = model.requests().length;
    const response = await assist(helper, id);
    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('CRISIS_SUPPORT');
    expect(response.json().notice).toEqual(expect.any(String));
    expect(response.json().notice).not.toBe('');
    expect(response.json().text).toBeUndefined();
    expect(model.requests()).toHaveLength(calls);
  });

  it('allows 20 calls per helper per hour, then 429 with Retry-After', async () => {
    const { helper, id } = await scenario();
    // An empty fake queue answers unavailable (503); every call still counts.
    for (let call = 0; call < 20; call += 1) {
      expect((await assist(helper, id)).statusCode).toBe(503);
    }
    const limited = await assist(helper, id);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  // R18.6 (contributor's call, D-066): the counter is one atomic upsert, so racing calls cannot
  // slip past the cap.
  it('lets at most 20 of 21 concurrent calls through and answers the rest 429', async () => {
    const { helper, id } = await scenario();
    const responses = await Promise.all(Array.from({ length: 21 }, () => assist(helper, id)));
    const limited = responses.filter((response) => response.statusCode === 429);
    expect(responses.length - limited.length).toBeLessThanOrEqual(20);
    expect(limited.length).toBeGreaterThanOrEqual(1);
    for (const response of limited) expect(response.json().error.code).toBe('RATE_LIMITED');
  });

  it('rejects an unknown kind', async () => {
    const { helper, id } = await scenario();
    expect((await assist(helper, id, 'WRITE_ANYTHING')).statusCode).toBe(400);
  });
});

describe('chat assistance disabled', () => {
  let off: StartedApp;

  beforeAll(async () => {
    off = await startApp({ env: env('disabled'), listen: false });
  });

  afterAll(async () => {
    await off.close();
  });

  it('answers 503 and lists threads with chat_assist_enabled false', async () => {
    const { helper, id } = await scenario(off);
    const response = await assist(helper, id, 'SUGGEST_REPLY', off);
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('CHAT_ASSIST_UNAVAILABLE');
    expect((await threadsOf(helper, off))[0]?.chat_assist_enabled).toBe(false);
  });
});
