/**
 * Chat over /api/v0 and the WebSocket push (requires PostgreSQL).
 *
 * V1_PROJECT_PLAN.md §2.1 "Peer flow" (chat only between the requester and the person
 * who accepted), §2.2 (Chat), §4.3 F7. Threads are inserted directly: creating one is
 * the accept flow's job, and the thread row is the contract chat reads.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession, revokeSession, SESSION_IDLE_TTL_SECONDS } from '../../src/auth/index.js';
import {
  createChatConnectionLifecycle,
  issueConnectTicket,
  pushToCounterpart,
  registerConnection,
  listConnectionIds,
  redeemConnectTicket,
  type ChatAccess,
  type ChatMessage,
} from '../../src/chat/index.js';
import { createUser } from '../../src/identity/index.js';
import {
  ApiGatewayConnectionPush,
  ConnectionPushError,
  type ConnectionPushPort,
  type LocalWebSocketPush,
} from '../../src/realtime/index.js';
import { createServer } from '../../src/http/server.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

interface ChatPage {
  messages: { body: string }[];
  next_cursor: string | null;
}

let app: StartedApp;
let local: LocalWebSocketPush;
let localPort: number;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_CHAT_PUSH_MODE: 'local',
    }),
    listen: false,
  });
  local = app.chatPush as LocalWebSocketPush;
  localPort = await local.listen(0);
  // Connection ids below are fixed, and registration ignores an existing id, so rows left
  // by an earlier run on the same database would belong to another user.
  await pool().query(`DELETE FROM chat_connections WHERE connection_id = ANY($1)`, [
    [
      'c-1',
      'c-2',
      'c-x',
      'aws-gone',
      'aws-live',
      'revoked-conn',
      'live-conn',
      'idle-conn',
      'helper-conn',
      'failing-conn',
    ],
  ]);
});

afterAll(async () => {
  await app.close();
});

function pool(): Pool {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

interface Person {
  readonly userId: string;
  readonly sessionId: string;
  readonly headers: Record<string, string>;
}

async function person(tenantId: string, label: string): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  // Passed scan and a county (Santa Clara), so requesting and accepting both work.
  await markVerifiedVeteran(pool(), tenantId, user.userId);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return {
    userId: user.userId,
    sessionId: session.session.sessionId,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

function keyed(who: Person, key: string = randomUUID()): Record<string, string> {
  return { ...who.headers, 'idempotency-key': key };
}

/** A requester with a Service Request, optionally with a thread to `accepter`. */
async function scenario(options: { accepted: boolean }) {
  const tenantId = randomUUID();
  const requester = await person(tenantId, 'requester');
  const accepter = await person(tenantId, 'accepter');
  const stranger = await person(tenantId, 'stranger');

  const opened = await app.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  expect(opened.statusCode).toBe(201);
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${opened.json().case_id as string}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD' },
  });
  expect(created.statusCode).toBe(201);
  const serviceRequestId: string = created.json().service_request_id;

  if (options.accepted) {
    await pool().query(
      `INSERT INTO chat_threads
         (chat_thread_id, tenant_id, service_request_id, requester_user_id, accepted_by_user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [randomUUID(), tenantId, serviceRequestId, requester.userId, accepter.userId],
    );
    await pool().query(
      `UPDATE service_requests SET accepted_by_user_id = $2
        WHERE tenant_id = $1 AND service_request_id = $3`,
      [tenantId, accepter.userId, serviceRequestId],
    );
  }
  return { tenantId, requester, accepter, stranger, serviceRequestId };
}

const messagesUrl = (serviceRequestId: string) =>
  `/api/v0/service-requests/${serviceRequestId}/chat/messages`;

function send(who: Person, serviceRequestId: string, body: string, key?: string) {
  return app.server.inject({
    method: 'POST',
    url: messagesUrl(serviceRequestId),
    headers: keyed(who, key),
    payload: { body },
  });
}

function list(who: Person, serviceRequestId: string, query = '') {
  return app.server.inject({
    method: 'GET',
    url: `${messagesUrl(serviceRequestId)}${query}`,
    headers: who.headers,
  });
}

describe('participant-only access', () => {
  it('lets the requester and the person who accepted read and write', async () => {
    const s = await scenario({ accepted: true });
    expect((await send(s.requester, s.serviceRequestId, 'hello from requester')).statusCode).toBe(
      201,
    );
    expect((await send(s.accepter, s.serviceRequestId, 'hello from accepter')).statusCode).toBe(
      201,
    );

    for (const who of [s.requester, s.accepter]) {
      const listed = await list(who, s.serviceRequestId);
      expect(listed.statusCode).toBe(200);
      const bodies = (listed.json().messages as { body: string }[]).map((m) => m.body);
      expect(bodies).toEqual(['hello from accepter', 'hello from requester']);
    }
  });

  it('answers anyone else with 404 for both list and send, and stores nothing', async () => {
    const s = await scenario({ accepted: true });
    expect((await list(s.stranger, s.serviceRequestId)).statusCode).toBe(404);
    expect((await send(s.stranger, s.serviceRequestId, 'let me in')).statusCode).toBe(404);
    expect((await list(s.requester, s.serviceRequestId)).json().messages).toEqual([]);
  });

  it('pages newest first with a cursor', async () => {
    const s = await scenario({ accepted: true });
    for (const text of ['one', 'two', 'three']) {
      await send(s.requester, s.serviceRequestId, text);
    }
    const first = (await list(s.accepter, s.serviceRequestId, '?limit=2')).json<ChatPage>();
    expect(first.messages.map((m) => m.body)).toEqual(['three', 'two']);
    const second = (
      await list(s.accepter, s.serviceRequestId, `?limit=2&cursor=${first.next_cursor as string}`)
    ).json<ChatPage>();
    expect(second.messages.map((m) => m.body)).toEqual(['one']);
    expect(second.next_cursor).toBeNull();
  });

  it('accepts a cursor in the format the chat-only encoder issued before C-21', async () => {
    const s = await scenario({ accepted: true });
    for (const text of ['one', 'two']) await send(s.requester, s.serviceRequestId, text);
    const stored = await pool().query<{ at: string; id: string }>(
      `SELECT to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
              m.chat_message_id AS id
         FROM chat_messages m
         JOIN chat_threads t ON t.chat_thread_id = m.chat_thread_id
        WHERE t.service_request_id = $1 AND m.body = 'two'`,
      [s.serviceRequestId],
    );
    const { at, id } = stored.rows[0]!;
    const legacy = Buffer.from(`${at}|${id}`, 'utf8').toString('base64url');
    const page = (await list(s.accepter, s.serviceRequestId, `?cursor=${legacy}`)).json<ChatPage>();
    expect(page.messages.map((m) => m.body)).toEqual(['one']);
  });
});

describe('chat before a request is accepted', () => {
  it('tells the requester chat is unavailable and everyone else not found', async () => {
    const s = await scenario({ accepted: false });
    const own = await list(s.requester, s.serviceRequestId);
    expect(own.statusCode).toBe(409);
    expect(own.json().error.code).toBe('CHAT_UNAVAILABLE');
    expect((await send(s.requester, s.serviceRequestId, 'anyone?')).statusCode).toBe(409);
    expect((await list(s.stranger, s.serviceRequestId)).statusCode).toBe(404);
  });
});

describe('idempotent send', () => {
  it('stores one message for a repeated key and replays the original', async () => {
    const s = await scenario({ accepted: true });
    const key = randomUUID();
    const first = await send(s.requester, s.serviceRequestId, 'only once', key);
    const second = await send(s.requester, s.serviceRequestId, 'only once', key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().replayed).toBe(true);
    expect(second.json().chat_message_id).toBe(first.json().chat_message_id);
    expect((await list(s.accepter, s.serviceRequestId)).json().messages).toHaveLength(1);
  });

  it('rejects the same key with different text', async () => {
    const s = await scenario({ accepted: true });
    const key = randomUUID();
    await send(s.requester, s.serviceRequestId, 'first text', key);
    const conflict = await send(s.requester, s.serviceRequestId, 'other text', key);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

/** Opens a WebSocket and resolves with the frames it receives, or the failure to connect. */
function openSocket(url: string) {
  const received: string[] = [];
  const socket = new WebSocket(url);
  socket.addEventListener('message', (event) => received.push(String(event.data)));
  const opened = new Promise<'open' | 'refused'>((resolve) => {
    socket.addEventListener('open', () => {
      resolve('open');
    });
    socket.addEventListener('error', () => {
      resolve('refused');
    });
  });
  return { socket, received, opened };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(predicate()).toBe(true);
}

describe('push on the local adapter', () => {
  it('delivers a new message to the other participant only', async () => {
    const s = await scenario({ accepted: true });
    const ticketFor = async (who: Person): Promise<string> => {
      const issued = await app.server.inject({
        method: 'POST',
        url: '/api/v0/chat/connect-tickets',
        headers: who.headers,
      });
      expect(issued.statusCode).toBe(201);
      expect(issued.json().websocket_url).toBe(`ws://127.0.0.1:${String(localPort)}`);
      return issued.json().ticket as string;
    };

    const requesterSocket = openSocket(
      `ws://127.0.0.1:${String(localPort)}/?ticket=${await ticketFor(s.requester)}`,
    );
    const accepterSocket = openSocket(
      `ws://127.0.0.1:${String(localPort)}/?ticket=${await ticketFor(s.accepter)}`,
    );
    expect(await requesterSocket.opened).toBe('open');
    expect(await accepterSocket.opened).toBe('open');

    const sent = await send(s.accepter, s.serviceRequestId, 'on my way');
    expect(sent.statusCode).toBe(201);

    await waitFor(() => requesterSocket.received.length === 1);
    const pushed = JSON.parse(requesterSocket.received[0] ?? '{}') as {
      type: string;
      message: { body: string; sender_user_id: string; chat_message_id: string };
    };
    expect(pushed.type).toBe('chat.message');
    expect(pushed.message.body).toBe('on my way');
    expect(pushed.message.sender_user_id).toBe(s.accepter.userId);
    expect(pushed.message.chat_message_id).toBe(sent.json().chat_message_id);
    // The sender's own connection is not notified of their own message.
    expect(accepterSocket.received).toEqual([]);

    requesterSocket.socket.close();
    accepterSocket.socket.close();
  });

  it('removes a connection from the registry when its socket closes', async () => {
    const s = await scenario({ accepted: true });
    const issued = await issueConnectTicket(pool(), {
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    const client = openSocket(`ws://127.0.0.1:${String(localPort)}/?ticket=${issued.ticket}`);
    expect(await client.opened).toBe('open');
    expect(await listConnectionIds(pool(), s.tenantId, s.requester.userId)).toHaveLength(1);
    client.socket.close();
    for (let i = 0; i < 100; i += 1) {
      if ((await listConnectionIds(pool(), s.tenantId, s.requester.userId)).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await listConnectionIds(pool(), s.tenantId, s.requester.userId)).toEqual([]);
  });
});

describe('connect tickets', () => {
  it('redeems an issued ticket exactly once', async () => {
    const s = await scenario({ accepted: true });
    const { ticket, expiresAt } = await issueConnectTicket(pool(), {
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    // expires_at comes from the DB clock; measure against it, not Node's (they drift by ms).
    const { rows } = await pool().query<{ now: Date }>('SELECT now() AS now');
    const ttl = expiresAt.getTime() - rows[0]!.now.getTime();
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(ttl).toBeGreaterThan(50_000);

    const lifecycle = createChatConnectionLifecycle(pool());
    expect(await lifecycle.connect({ connectionId: 'c-1', ticket })).toBe('accepted');
    expect(await lifecycle.connect({ connectionId: 'c-2', ticket })).toBe('refused');
    expect(await listConnectionIds(pool(), s.tenantId, s.requester.userId)).toEqual(['c-1']);
    await lifecycle.disconnect('c-1');
  });

  it('refuses an expired ticket', async () => {
    const s = await scenario({ accepted: true });
    const { ticket } = await issueConnectTicket(pool(), {
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    await pool().query(
      `UPDATE chat_connect_tickets SET expires_at = now() - interval '1 second'
        WHERE user_id = $1`,
      [s.requester.userId],
    );
    expect(await redeemConnectTicket(pool(), ticket)).toBeUndefined();
  });

  it('refuses an unknown or missing ticket, and stores only a hash', async () => {
    const s = await scenario({ accepted: true });
    const lifecycle = createChatConnectionLifecycle(pool());
    expect(await lifecycle.connect({ connectionId: 'c-x', ticket: 'not-a-ticket' })).toBe(
      'refused',
    );
    expect(await lifecycle.connect({ connectionId: 'c-x', ticket: undefined })).toBe('refused');

    const { ticket } = await issueConnectTicket(pool(), {
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    const stored = await pool().query(
      `SELECT ticket_hash FROM chat_connect_tickets WHERE user_id = $1`,
      [s.requester.userId],
    );
    expect(stored.rows[0]?.ticket_hash).not.toBe(ticket);

    const refused = openSocket(`ws://127.0.0.1:${String(localPort)}/?ticket=bogus`);
    expect(await refused.opened).toBe('refused');
  });

  it('is issued only to a signed-in person', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/chat/connect-tickets',
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('push failure and gone connections', () => {
  const message = (access: ChatAccess, senderUserId: string): ChatMessage => ({
    chatMessageId: randomUUID(),
    serviceRequestId: access.serviceRequestId,
    senderUserId,
    body: 'x',
    createdAt: new Date().toISOString(),
  });

  it('drops a connection the AWS adapter reports gone (HTTP 410)', async () => {
    const s = await scenario({ accepted: true });
    await registerConnection(pool(), {
      connectionId: 'aws-gone',
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    await registerConnection(pool(), {
      connectionId: 'aws-live',
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    const sentTo: string[] = [];
    const push = new ApiGatewayConnectionPush({
      endpoint: 'https://abc123.execute-api.us-west-2.amazonaws.com/staging',
      region: 'us-west-2',
      client: {
        send: (command) => {
          const id = (command.input as { ConnectionId: string }).ConnectionId;
          sentTo.push(id);
          return id === 'aws-gone'
            ? Promise.reject(
                Object.assign(new Error('Gone'), {
                  name: 'GoneException',
                  $metadata: { httpStatusCode: 410 },
                }),
              )
            : Promise.resolve({ $metadata: {} });
        },
      },
    });

    const access: ChatAccess = {
      chatThreadId: randomUUID(),
      serviceRequestId: s.serviceRequestId,
      counterpartUserId: s.requester.userId,
      counterpartRole: 'REQUESTER',
    };
    await pushToCounterpart(
      { pool: pool(), push, log: { warn: () => undefined } },
      s.tenantId,
      access,
      message(access, s.accepter.userId),
    );

    expect(sentTo.sort()).toEqual(['aws-gone', 'aws-live']);
    expect(await listConnectionIds(pool(), s.tenantId, s.requester.userId)).toEqual(['aws-live']);
  });

  it('sends nothing to a connection whose session was revoked or went idle', async () => {
    const s = await scenario({ accepted: true });
    const liveSession = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId: s.tenantId,
      userId: s.requester.userId,
    });
    for (const [connectionId, sessionId] of [
      ['revoked-conn', s.requester.sessionId],
      ['live-conn', liveSession.session.sessionId],
    ] as const) {
      await registerConnection(pool(), {
        connectionId,
        tenantId: s.tenantId,
        userId: s.requester.userId,
        sessionId,
      });
    }
    await revokeSession(pool(), s.requester.sessionId, 'LOGOUT');

    // A session idle past the idle TTL is dead too, the same as in resolveSession.
    const idleSession = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId: s.tenantId,
      userId: s.requester.userId,
    });
    await registerConnection(pool(), {
      connectionId: 'idle-conn',
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: idleSession.session.sessionId,
    });
    const idleTicket = await issueConnectTicket(pool(), {
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: idleSession.session.sessionId,
    });
    await pool().query(
      `UPDATE sessions SET last_seen_at = now() - make_interval(secs => $2)
        WHERE session_id = $1`,
      [idleSession.session.sessionId, SESSION_IDLE_TTL_SECONDS.value + 60],
    );

    const sentTo: string[] = [];
    const recording: ConnectionPushPort = {
      implementation: 'recording',
      connectUrl: () => 'wss://invalid.example',
      send: (connectionId) => {
        sentTo.push(connectionId);
        return Promise.resolve('delivered');
      },
    };
    const access: ChatAccess = {
      chatThreadId: randomUUID(),
      serviceRequestId: s.serviceRequestId,
      counterpartUserId: s.requester.userId,
      counterpartRole: 'REQUESTER',
    };
    await pushToCounterpart(
      { pool: pool(), push: recording, log: { warn: () => undefined } },
      s.tenantId,
      access,
      message(access, s.accepter.userId),
    );
    expect(sentTo).toEqual(['live-conn']);
    expect(await redeemConnectTicket(pool(), idleTicket.ticket)).toBeUndefined();

    // A ticket issued before the revocation cannot be redeemed either.
    const late = await issueConnectTicket(pool(), {
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: liveSession.session.sessionId,
    });
    await revokeSession(pool(), liveSession.session.sessionId, 'LOGOUT');
    expect(await redeemConnectTicket(pool(), late.ticket)).toBeUndefined();
  });

  it('pushes to the helper only while they still hold the request (C-05)', async () => {
    const s = await scenario({ accepted: true });
    await registerConnection(pool(), {
      connectionId: 'helper-conn',
      tenantId: s.tenantId,
      userId: s.accepter.userId,
      sessionId: s.accepter.sessionId,
    });
    const sentTo: string[] = [];
    const recording: ConnectionPushPort = {
      implementation: 'recording',
      connectUrl: () => 'wss://invalid.example',
      send: (connectionId) => {
        sentTo.push(connectionId);
        return Promise.resolve('delivered');
      },
    };
    const access: ChatAccess = {
      chatThreadId: randomUUID(),
      serviceRequestId: s.serviceRequestId,
      counterpartUserId: s.accepter.userId,
      counterpartRole: 'HOLDER',
    };
    const deps = { pool: pool(), push: recording, log: { warn: () => undefined } };
    await pushToCounterpart(deps, s.tenantId, access, message(access, s.requester.userId));
    expect(sentTo).toEqual(['helper-conn']);

    // Once the case closes, the helper's REST read is 404, so the push stops too.
    await pool().query(
      `UPDATE support_cases SET status = 'CLOSED', closed_at = now()
        WHERE tenant_id = $1 AND case_id = (
          SELECT case_id FROM service_requests WHERE service_request_id = $2)`,
      [s.tenantId, s.serviceRequestId],
    );
    await pushToCounterpart(deps, s.tenantId, access, message(access, s.requester.userId));
    expect(sentTo).toEqual(['helper-conn']);
  });

  it('still stores and returns the message when the push provider fails', async () => {
    const s = await scenario({ accepted: true });
    await registerConnection(pool(), {
      connectionId: 'failing-conn',
      tenantId: s.tenantId,
      userId: s.requester.userId,
      sessionId: s.requester.sessionId,
    });
    const failing: ConnectionPushPort = {
      implementation: 'always-fails',
      connectUrl: () => 'wss://invalid.example',
      send: () => Promise.reject(new ConnectionPushError('unavailable')),
    };
    const server = createServer({
      config: app.config,
      buildInfo: () => app.buildInfo,
      pool: pool(),
      challengeDelivery: app.challengeDelivery,
      mfa: app.mfa,
      chatPush: failing,
      logger: false,
    });

    const response = await server.inject({
      method: 'POST',
      url: messagesUrl(s.serviceRequestId),
      headers: keyed(s.accepter),
      payload: { body: 'stored despite push failure' },
    });
    expect(response.statusCode).toBe(201);
    const listed = await list(s.requester, s.serviceRequestId);
    expect(listed.json().messages[0].body).toBe('stored despite push failure');
    // A failed (not gone) push keeps the registry entry.
    expect(await listConnectionIds(pool(), s.tenantId, s.requester.userId)).toEqual([
      'failing-conn',
    ]);
    await server.close();
  });
});
