/**
 * Helper release over /api/v0 (requires PostgreSQL).
 *
 * suas-specs V1_MVP_PROPOSAL.md R8.5: the accepter hands a request back with a reason.
 * It returns to SUBMITTED and the open list, the accepter's access and chat go, the chat
 * thread closes (read-only for the requester), the requester is told, and the same helper
 * may accept again, which opens a new thread.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { expireDueRequests } from '../../src/coordination/expiry.js';
import { widenDueRequests } from '../../src/coordination/widening.js';
import {
  executeServiceRequestCommand,
  NotRequestHolderError,
} from '../../src/coordination/index.js';
import { listAggregateEvents } from '../../src/events/index.js';
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

function command(who: Person, id: string, name: string, payload: object = {}) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/commands/${name}`,
    headers: keyed(who),
    payload,
  });
}

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

async function submittedRequest(requester: Person): Promise<string> {
  const opened = await app.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  expect([200, 201]).toContain(opened.statusCode);
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${opened.json().case_id}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().service_request_id;
  expect((await command(requester, id, 'SUBMIT')).statusCode).toBe(200);
  return id;
}

async function openIds(who: Person): Promise<string[]> {
  const response = await get(who, '/service-requests?ownership=open');
  expect(response.statusCode).toBe(200);
  const body: { service_requests: { service_request_id: string }[] } = response.json();
  return body.service_requests.map((item) => item.service_request_id);
}

async function threadsOf(who: Person) {
  const response = await get(who, '/chat/threads');
  expect(response.statusCode).toBe(200);
  const body: { threads: { service_request_id: string; released_at: string | null }[] } =
    response.json();
  return body.threads;
}

/** A requester, the helper who accepts, and a bystander in the same county. */
async function acceptedRequest() {
  const tenantId = randomUUID();
  const requester = await person(tenantId, 'requester');
  const helper = await person(tenantId, 'helper');
  const bystander = await person(tenantId, 'bystander');
  const id = await submittedRequest(requester);
  expect((await accept(helper, id)).statusCode).toBe(200);
  return { tenantId, requester, helper, bystander, id };
}

describe('who may release, and why', () => {
  it('lets only the accepter release, and only with a reason', async () => {
    const { requester, helper, bystander, id } = await acceptedRequest();

    expect((await command(requester, id, 'RELEASE', { reason: 'no' })).statusCode).toBe(403);
    expect((await command(bystander, id, 'RELEASE', { reason: 'no' })).statusCode).toBe(404);
    const noReason = await command(helper, id, 'RELEASE');
    expect(noReason.statusCode).toBe(400);
    expect(noReason.json().error.code).toBe('VALIDATION_FAILED');

    const stored = await pool().query<{ status: string }>(
      `SELECT status FROM service_requests WHERE service_request_id = $1`,
      [id],
    );
    expect(stored.rows[0]?.status).toBe('ACCEPTED');
  });

  it('refuses a stale holder whose request was released and accepted by someone else', async () => {
    const { tenantId, helper, bystander, id } = await acceptedRequest();
    const released = await command(helper, id, 'RELEASE', { reason: 'cannot make it' });
    expect(released.statusCode).toBe(200);
    expect((await accept(bystander, id)).statusCode).toBe(200);

    // The service layer re-checks the holder under the row lock, past any earlier route check.
    await expect(
      executeServiceRequestCommand(pool(), {
        tenantId,
        serviceRequestId: id,
        command: 'RELEASE',
        actorId: helper.userId,
        actorType: 'USER',
        reason: 'changed my mind',
      }),
    ).rejects.toBeInstanceOf(NotRequestHolderError);

    const stored = await pool().query<{ status: string; accepted_by_user_id: string }>(
      `SELECT status, accepted_by_user_id FROM service_requests WHERE service_request_id = $1`,
      [id],
    );
    expect(stored.rows[0]).toEqual({ status: 'ACCEPTED', accepted_by_user_id: bystander.userId });
    const live = await pool().query(
      `SELECT 1 FROM chat_threads WHERE service_request_id = $1 AND released_at IS NULL`,
      [id],
    );
    expect(live.rowCount).toBe(1);
  });

  it('refuses to release once work has started', async () => {
    const { helper, id } = await acceptedRequest();
    expect((await command(helper, id, 'START')).statusCode).toBe(200);
    const refused = await command(helper, id, 'RELEASE', { reason: 'cannot make it' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('ILLEGAL_TRANSITION');
  });
});

describe('after a release', () => {
  it('returns the request to the open list, clears the holder and tells the requester', async () => {
    const { requester, helper, bystander, id } = await acceptedRequest();
    expect(await openIds(bystander)).not.toContain(id);

    const released = await command(helper, id, 'RELEASE', { reason: 'Private reason text' });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().status).toBe('SUBMITTED');

    expect(await openIds(bystander)).toContain(id);
    const row = await pool().query<{
      accepted_by_user_id: string | null;
      accepted_at: Date | null;
    }>(
      `SELECT accepted_by_user_id, accepted_at FROM service_requests
        WHERE service_request_id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({ accepted_by_user_id: null, accepted_at: null });

    const notices = await pool().query(
      `SELECT recipient_user_id, channel FROM notifications
        WHERE subject_id = $1 AND reason = 'service_request_released'`,
      [id],
    );
    expect(notices.rows).toEqual([{ recipient_user_id: requester.userId, channel: 'IN_APP' }]);

    // The audit event carries ids, never the reason text.
    const audit = await pool().query<{ payload: object }>(
      `SELECT payload FROM audit_events
        WHERE event_type = 'SERVICE_REQUEST_RELEASED' AND target_id = $1`,
      [id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0]?.payload)).not.toContain('Private reason');
  });

  it('emits one SERVICE_REQUEST_RELEASED domain event with ids only (DISPATCH.md §4, R8.5)', async () => {
    const { helper, id } = await acceptedRequest();
    const released = await command(helper, id, 'RELEASE', { reason: 'Private reason text' });
    expect(released.statusCode, released.body).toBe(200);

    const events = await pool().query<{
      aggregate_type: string;
      actor_id: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT aggregate_type, actor_id, payload FROM domain_events
        WHERE event_type = 'SERVICE_REQUEST_RELEASED' AND aggregate_id = $1`,
      [id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.aggregate_type).toBe('ServiceRequest');
    expect(events.rows[0]?.actor_id).toBe(helper.userId);
    expect(Object.keys(events.rows[0]?.payload ?? {}).sort()).toEqual(['case_id', 'category']);
    expect(JSON.stringify(events.rows[0]?.payload)).not.toContain('Private reason');

    // A refused second release writes no second event.
    const again = await command(helper, id, 'RELEASE', { reason: 'Again' });
    expect(again.statusCode).not.toBe(200);
    const after = await pool().query(
      `SELECT 1 FROM domain_events
        WHERE event_type = 'SERVICE_REQUEST_RELEASED' AND aggregate_id = $1`,
      [id],
    );
    expect(after.rows).toHaveLength(1);
  });

  it('removes the released helper: detail, chat and counts all go', async () => {
    const { requester, helper, id } = await acceptedRequest();
    expect((await say(helper, id, 'On my way')).statusCode).toBe(201);
    const before = await get(helper, '/service-requests?ownership=mine');
    expect(before.json().counts).toEqual({ helping_now: 1, closed_last_30_days: 0 });

    const released = await command(helper, id, 'RELEASE', { reason: 'cannot make it' });
    expect(released.statusCode).toBe(200);

    expect((await get(helper, `/service-requests/${id}`)).statusCode).toBe(404);
    expect((await get(helper, `/service-requests/${id}/chat/messages`)).statusCode).toBe(404);
    expect((await say(helper, id, 'Still here?')).statusCode).toBe(404);
    expect(await threadsOf(helper)).toEqual([]);
    const after = await get(helper, '/service-requests?ownership=mine');
    expect(after.json().service_requests).toEqual([]);
    expect(after.json().counts).toEqual({ helping_now: 0, closed_last_30_days: 0 });

    // The requester keeps the thread, read-only, and sees when it closed.
    const messages = await get(requester, `/service-requests/${id}/chat/messages`);
    expect(messages.statusCode).toBe(200);
    const page: { messages: { body: string }[] } = messages.json();
    expect(page.messages.map((m) => m.body)).toEqual(['On my way']);
    const refused = await say(requester, id, 'Hello?');
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('CHAT_CLOSED');
    const threads = await threadsOf(requester);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.released_at).not.toBeNull();
  });
});

describe('accepting again', () => {
  it('lets the same helper accept, with a new live thread and a new accepted_at', async () => {
    const { requester, helper, id } = await acceptedRequest();
    const firstAt = (await get(requester, `/service-requests/${id}`)).json().accepted_at;
    expect((await say(helper, id, 'First thread')).statusCode).toBe(201);
    const released = await command(helper, id, 'RELEASE', { reason: 'cannot make it' });
    expect(released.statusCode).toBe(200);
    expect((await get(requester, `/service-requests/${id}`)).json().accepted_at).toBeNull();

    expect((await accept(helper, id)).statusCode).toBe(200);

    const detail = (await get(helper, `/service-requests/${id}`)).json();
    expect(detail.status).toBe('ACCEPTED');
    expect(Date.parse(detail.accepted_at)).toBeGreaterThan(Date.parse(firstAt));
    const threads = await pool().query<{ released_at: Date | null }>(
      `SELECT released_at FROM chat_threads WHERE service_request_id = $1 ORDER BY created_at`,
      [id],
    );
    expect(threads.rows.map((row) => row.released_at !== null)).toEqual([true, false]);

    // The new thread starts empty and takes messages from both sides.
    const empty = await get(helper, `/service-requests/${id}/chat/messages`);
    expect(empty.json().messages).toEqual([]);
    expect((await say(helper, id, 'Second thread')).statusCode).toBe(201);
    expect((await say(requester, id, 'Thanks')).statusCode).toBe(201);

    // The helper lists only the live thread; the requester also sees the closed one.
    expect(await threadsOf(helper)).toHaveLength(1);
    const requesterClosed = (await threadsOf(requester)).map((t) => t.released_at !== null);
    expect(requesterClosed.sort()).toEqual([false, true]);
    const counts = await get(helper, '/service-requests?ownership=mine');
    expect(counts.json().counts.helping_now).toBe(1);
  });
});

describe('the expiry clock after a release', () => {
  it('keeps the original submitted_at through a release and a re-accept (R8.4, D-061)', async () => {
    const { helper, id } = await acceptedRequest();
    // Stand in for a request first submitted 73 hours ago.
    const original = await pool().query<{ submitted_at: Date }>(
      `UPDATE service_requests SET submitted_at = now() - interval '73 hours'
        WHERE service_request_id = $1 RETURNING submitted_at`,
      [id],
    );
    const submittedAt = original.rows[0]?.submitted_at.toISOString();
    const storedSubmittedAt = async () =>
      (
        await pool().query<{ submitted_at: Date }>(
          `SELECT submitted_at FROM service_requests WHERE service_request_id = $1`,
          [id],
        )
      ).rows[0]?.submitted_at.toISOString();

    expect((await command(helper, id, 'RELEASE', { reason: 'cannot make it' })).statusCode).toBe(
      200,
    );
    expect(await storedSubmittedAt()).toBe(submittedAt);
    expect((await accept(helper, id)).statusCode).toBe(200);
    expect((await command(helper, id, 'RELEASE', { reason: 'still cannot' })).statusCode).toBe(200);
    expect(await storedSubmittedAt()).toBe(submittedAt);

    // Waiting again after the release, it expires on the first submit's 72-hour clock.
    const result = await expireDueRequests(pool());
    expect(result.expired.map((item) => item.serviceRequestId)).toContain(id);
    const after = await pool().query<{ status: string }>(
      `SELECT status FROM service_requests WHERE service_request_id = $1`,
      [id],
    );
    expect(after.rows[0]?.status).toBe('EXPIRED');
  });
});

describe('retrying a release', () => {
  it('gives the released helper the stored result for the same key, and 404 for a new one', async () => {
    const { helper, id } = await acceptedRequest();
    const headers = keyed(helper);
    const release = () =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${id}/commands/RELEASE`,
        headers,
        payload: { reason: 'cannot make it' },
      });
    const first = await release();
    expect(first.statusCode).toBe(200);
    expect(first.json().replayed).toBe(false);

    // The helper has lost access, yet the same key and body replay the stored result.
    const retry = await release();
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ...first.json(), replayed: true });
    const notices = await pool().query(`SELECT 1 FROM notifications WHERE dedupe_key LIKE $1`, [
      `request-released:${id}:%`,
    ]);
    expect(notices.rowCount).toBe(1);

    // A new key, or the same key with a different body, is a new command: the uniform 404.
    expect((await command(helper, id, 'RELEASE', { reason: 'cannot make it' })).statusCode).toBe(
      404,
    );
    const changed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/commands/RELEASE`,
      headers,
      payload: { reason: 'another reason' },
    });
    expect(changed.statusCode).toBe(404);
  });
});

describe('widening after a release', () => {
  it('clears widened_at and widens again only once the delay has passed since the release', async () => {
    const { helper, id } = await acceptedRequest();
    // Stand in for a request submitted two hours ago that widened before it was accepted.
    await pool().query(
      `UPDATE service_requests
          SET submitted_at = now() - interval '2 hours', widened_at = now() - interval '90 minutes'
        WHERE service_request_id = $1`,
      [id],
    );
    const widenedAt = async () =>
      (
        await pool().query<{ widened_at: Date | null }>(
          `SELECT widened_at FROM service_requests WHERE service_request_id = $1`,
          [id],
        )
      ).rows[0]?.widened_at ?? null;

    expect((await command(helper, id, 'RELEASE', { reason: 'cannot make it' })).statusCode).toBe(
      200,
    );
    // R8.5: back to SUBMITTED, widening applies as for a new submit.
    expect(await widenedAt()).toBeNull();

    // The first submit is two hours old, but the delay counts from the release.
    const soon = await widenDueRequests(pool(), { now: new Date() });
    expect(soon.widened.map((item) => item.serviceRequestId)).not.toContain(id);
    expect(await widenedAt()).toBeNull();

    const later = new Date(Date.now() + (soon.delayMinutes + 1) * 60_000);
    const due = await widenDueRequests(pool(), { now: later });
    expect(due.widened.map((item) => item.serviceRequestId)).toContain(id);
    expect(await widenedAt()).not.toBeNull();
  });
});

describe('request command path and actor rules', () => {
  it('takes the lowercase command path from API.md §8/§18 and keeps UPPERCASE as an alias', async () => {
    const first = await acceptedRequest();
    const lower = await command(first.helper, first.id, 'release', { reason: 'cannot make it' });
    expect(lower.statusCode).toBe(200);
    expect(lower.json().status).toBe('SUBMITTED');

    const second = await acceptedRequest();
    const upper = await command(second.helper, second.id, 'RELEASE', { reason: 'cannot make it' });
    expect(upper.statusCode).toBe(200);
    expect(upper.json().status).toBe('SUBMITTED');
  });

  it('refuses EXPIRE from the holder: only the System expires a request (DISPATCH.md §4)', async () => {
    const { requester, helper, id } = await acceptedRequest();
    const response = await command(helper, id, 'expire');
    expect(response.statusCode).toBe(403);
    expect((await get(requester, `/service-requests/${id}`)).json().status).toBe('ACCEPTED');
  });

  it('answers an unknown to or expected_status with 400, not a conflict', async () => {
    const { helper, id } = await acceptedRequest();
    for (const payload of [{ expected_status: 'NOT_A_STATUS' }, { to: 'NOWHERE' }]) {
      const response = await command(helper, id, 'start', payload);
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('VALIDATION_FAILED');
    }
  });

  it('re-checks the holder under the row lock for a non-release command', async () => {
    const { tenantId, helper, bystander, id } = await acceptedRequest();
    expect((await command(helper, id, 'release', { reason: 'busy' })).statusCode).toBe(200);
    expect((await accept(bystander, id)).statusCode).toBe(200);
    await expect(
      executeServiceRequestCommand(pool(), {
        tenantId,
        serviceRequestId: id,
        command: 'START',
        actorId: helper.userId,
        actorType: 'USER',
        requireHolder: true,
      }),
    ).rejects.toBeInstanceOf(NotRequestHolderError);
  });

  it('emits SERVICE_FULFILLED on FULFILL, ids only (DISPATCH.md §4)', async () => {
    const { tenantId, helper, id } = await acceptedRequest();
    expect((await command(helper, id, 'start')).statusCode).toBe(200);
    expect((await command(helper, id, 'fulfill')).statusCode).toBe(200);
    const events = await listAggregateEvents(pool(), {
      tenantId,
      aggregateType: 'ServiceRequest',
      aggregateId: id,
    });
    const fulfilled = events.filter((event) => event.eventType === 'SERVICE_FULFILLED');
    expect(fulfilled).toHaveLength(1);
    expect(Object.keys(fulfilled[0]?.payload ?? {}).sort()).toEqual(['case_id', 'category']);
  });

  it('leaves case_id off the open list (DISPATCH.md §13.3)', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const helper = await person(tenantId, 'helper');
    const id = await submittedRequest(requester);
    const response = await get(helper, '/service-requests?ownership=open');
    const item = response
      .json()
      .service_requests.find(
        (entry: { service_request_id: string }) => entry.service_request_id === id,
      );
    expect(item).toBeDefined();
    expect(item).not.toHaveProperty('case_id');
  });
});
