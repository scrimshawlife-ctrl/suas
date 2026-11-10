/**
 * Earlier chat threads after a release, over /api/v0 (requires PostgreSQL).
 *
 * suas-specs V1_MVP_PROPOSAL.md R8.11: the requester lists every thread of a request and
 * reads a closed one read-only with `thread`; no helper ever reads a closed thread, and
 * without `thread` the live thread is returned as before.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { ChatClosedError } from '../../src/chat/index.js';
import { insertChatMessage } from '../../src/chat/messages.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

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

interface Person {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

async function person(tenantId: string, label: string): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  await markVerifiedVeteran(pool(), tenantId, user.userId, 'SANTA_CLARA');
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return { userId: user.userId, headers: { authorization: `Bearer ${session.credential}` } };
}

function keyed(who: Person): Record<string, string> {
  return { ...who.headers, 'idempotency-key': randomUUID() };
}

const get = (who: Person, url: string) =>
  app.server.inject({ method: 'GET', url: `/api/v0${url}`, headers: who.headers });

const accept = (who: Person, id: string) =>
  app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/accept`,
    headers: who.headers,
  });

const say = (who: Person, id: string, body: string) =>
  app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/chat/messages`,
    headers: keyed(who),
    payload: { body },
  });

const release = (who: Person, id: string) =>
  app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/commands/RELEASE`,
    headers: keyed(who),
    payload: { reason: 'cannot make it' },
  });

const messagesUrl = (id: string, thread?: string) =>
  `/service-requests/${id}/chat/messages${thread === undefined ? '' : `?thread=${thread}`}`;

async function bodies(who: Person, id: string, thread?: string): Promise<string[]> {
  const response = await get(who, messagesUrl(id, thread));
  expect(response.statusCode, response.body).toBe(200);
  const page: { messages: { body: string }[] } = response.json();
  return page.messages.map((message) => message.body);
}

async function submittedRequest(requester: Person): Promise<string> {
  const opened = await app.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${opened.json().case_id}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().service_request_id;
  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/commands/SUBMIT`,
    headers: keyed(requester),
    payload: {},
  });
  expect(submitted.statusCode).toBe(200);
  return id;
}

interface ListedThread {
  chat_thread_id: string;
  service_request_id: string;
  released_at: string | null;
}

async function threadsOf(who: Person, id: string): Promise<ListedThread[]> {
  const response = await get(who, '/chat/threads');
  expect(response.statusCode).toBe(200);
  const body: { threads: ListedThread[] } = response.json();
  return body.threads.filter((thread) => thread.service_request_id === id);
}

/**
 * helper1 accepts, chats and releases; helper2 then accepts and chats on the live thread.
 * Returns the old thread id (read by the requester only) and the live one.
 */
async function releasedAndReaccepted() {
  const tenantId = randomUUID();
  const requester = await person(tenantId, 'requester');
  const helper1 = await person(tenantId, 'helper1');
  const helper2 = await person(tenantId, 'helper2');
  const id = await submittedRequest(requester);
  expect((await accept(helper1, id)).statusCode).toBe(200);
  expect((await say(helper1, id, 'Old hello')).statusCode).toBe(201);
  expect((await say(requester, id, 'Old reply')).statusCode).toBe(201);
  expect((await release(helper1, id)).statusCode).toBe(200);
  expect((await accept(helper2, id)).statusCode).toBe(200);
  expect((await say(helper2, id, 'New hello')).statusCode).toBe(201);

  const listed = await threadsOf(requester, id);
  const oldThread = listed.find((thread) => thread.released_at !== null);
  const liveThread = listed.find((thread) => thread.released_at === null);
  if (oldThread === undefined || liveThread === undefined) throw new Error('threads missing');
  return {
    tenantId,
    requester,
    helper1,
    helper2,
    id,
    oldId: oldThread.chat_thread_id,
    liveId: liveThread.chat_thread_id,
  };
}

describe('the requester and earlier threads', () => {
  it('lists every thread newest first and reads the old one by id', async () => {
    const { tenantId, requester, id, oldId, liveId } = await releasedAndReaccepted();

    const listed = await threadsOf(requester, id);
    expect(listed.map((thread) => thread.chat_thread_id)).toEqual([liveId, oldId]);
    expect(listed[0]?.released_at).toBeNull();
    expect(listed[1]?.released_at).not.toBeNull();

    expect(await bodies(requester, id, oldId)).toEqual(['Old reply', 'Old hello']);
    expect(await bodies(requester, id, liveId)).toEqual(['New hello']);
    expect(await bodies(requester, id)).toEqual(['New hello']);

    // The old thread stays read-only: the store refuses a message on it.
    await expect(
      insertChatMessage(pool(), {
        tenantId,
        chatThreadId: oldId,
        senderUserId: requester.userId,
        body: 'Anyone there?',
      }),
    ).rejects.toBeInstanceOf(ChatClosedError);
  });

  it('refuses a post naming an earlier thread with the same 404 as an unknown id', async () => {
    const { requester, id, oldId, liveId } = await releasedAndReaccepted();
    const post = (thread: string) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0${messagesUrl(id, thread)}`,
        headers: keyed(requester),
        payload: { body: 'Meant for the old chat' },
      });
    const old = await post(oldId);
    const unknown = await post(randomUUID());
    expect(old.statusCode).toBe(404);
    expect(unknown.statusCode).toBe(404);
    expect(old.json().error.code).toBe(unknown.json().error.code);
    expect(old.json().error.message).toBe(unknown.json().error.message);
    // Nothing was written to either thread.
    expect(await bodies(requester, id, oldId)).toEqual(['Old reply', 'Old hello']);
    expect(await bodies(requester, id)).toEqual(['New hello']);

    // Naming the live thread posts to it.
    const live = await post(liveId);
    expect(live.statusCode).toBe(201);
    expect(await bodies(requester, id)).toEqual(['Meant for the old chat', 'New hello']);
  });
});

describe('helpers and earlier threads', () => {
  it('never lets the released helper read either thread by id', async () => {
    const { helper1, id, oldId, liveId } = await releasedAndReaccepted();
    expect((await get(helper1, messagesUrl(id, oldId))).statusCode).toBe(404);
    expect((await get(helper1, messagesUrl(id, liveId))).statusCode).toBe(404);
    expect((await get(helper1, messagesUrl(id))).statusCode).toBe(404);
  });

  it('shows the current helper only the live thread', async () => {
    const { helper2, id, oldId, liveId } = await releasedAndReaccepted();
    expect((await get(helper2, messagesUrl(id, oldId))).statusCode).toBe(404);
    expect(await bodies(helper2, id)).toEqual(['New hello']);
    expect(await bodies(helper2, id, liveId)).toEqual(['New hello']);
    const own = await threadsOf(helper2, id);
    expect(own.map((thread) => thread.chat_thread_id)).toEqual([liveId]);
  });
});

describe('a bad thread id', () => {
  it('is 404 for a thread of another request and 400 when malformed', async () => {
    const first = await releasedAndReaccepted();
    const second = await releasedAndReaccepted();

    const foreign = await get(first.requester, messagesUrl(first.id, second.oldId));
    expect(foreign.statusCode).toBe(404);
    const unknown = await get(first.requester, messagesUrl(first.id, randomUUID()));
    expect(unknown.statusCode).toBe(404);

    const malformed = await get(first.requester, messagesUrl(first.id, 'not-a-uuid'));
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error.code).toBe('VALIDATION_FAILED');
  });
});
