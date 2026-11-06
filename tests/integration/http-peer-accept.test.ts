/**
 * Peer accept over /api/v0 (requires PostgreSQL).
 *
 * V1_PROJECT_PLAN.md §2.1 "Peer flow", "County", "Widening" and §4.3 F4-F5:
 * - any signed-in person lists open requests in their county and accepts one;
 * - first accept wins and the request leaves other people's lists;
 * - a requester cannot accept their own request;
 * - only the person who accepted runs the request's accepter commands.
 * SUAS-specs API.md §5 (cursor pagination), §4 (no existence leakage).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createUser, type ServiceCounty } from '../../src/identity/index.js';
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

interface Person {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

async function person(
  tenantId: string,
  county: ServiceCounty | undefined,
  label = 'person',
): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    ...(county !== undefined ? { county } : {}),
  });
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return { userId: user.userId, headers: { authorization: `Bearer ${session.credential}` } };
}

function keyed(who: Person): Record<string, string> {
  return { ...who.headers, 'idempotency-key': randomUUID() };
}

/** The requester opens a case and creates a request; `submit` puts it on the open list. */
async function request(requester: Person, options: { submit?: boolean } = {}) {
  const opened = await app.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  expect(opened.statusCode).toBe(201);
  const caseId: string = opened.json().case_id;
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${caseId}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD' },
  });
  expect(created.statusCode).toBe(201);
  const serviceRequestId: string = created.json().service_request_id;
  if (options.submit !== false) {
    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${serviceRequestId}/commands/SUBMIT`,
      headers: keyed(requester),
      payload: {},
    });
    expect(submitted.statusCode).toBe(200);
  }
  return { caseId, serviceRequestId };
}

async function openIds(who: Person): Promise<string[]> {
  const response = await app.server.inject({
    method: 'GET',
    url: '/api/v0/service-requests?ownership=open',
    headers: who.headers,
  });
  expect(response.statusCode).toBe(200);
  const body: { service_requests: { service_request_id: string }[] } = response.json();
  return body.service_requests.map((item) => item.service_request_id);
}

function accept(who: Person, serviceRequestId: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${serviceRequestId}/accept`,
    headers: who.headers,
  });
}

describe('county scoping', () => {
  it('lists a submitted request to people in the same county only', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const sameCounty = await person(tenantId, 'SANTA_CLARA');
    const bordering = await person(tenantId, 'ALAMEDA');
    const farAway = await person(tenantId, 'MERCED');
    const { serviceRequestId } = await request(requester);

    expect(await openIds(sameCounty)).toEqual([serviceRequestId]);
    // Widening has not run yet, so even a bordering county sees nothing.
    expect(await openIds(bordering)).toEqual([]);
    expect(await openIds(farAway)).toEqual([]);
  });

  it('shows the request to bordering counties once it is widened, and no one else', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SAN_MATEO', 'requester');
    const bordering = await person(tenantId, 'SANTA_CRUZ');
    // San Mateo and Alameda meet only across the bay; a water border counts.
    const acrossWater = await person(tenantId, 'ALAMEDA');
    const notBordering = await person(tenantId, 'MERCED');
    const { serviceRequestId } = await request(requester);

    expect(await openIds(bordering)).toEqual([]);
    await pool().query(
      `UPDATE service_requests SET widened_at = now() WHERE service_request_id = $1`,
      [serviceRequestId],
    );

    expect(await openIds(bordering)).toEqual([serviceRequestId]);
    expect(await openIds(acrossWater)).toEqual([serviceRequestId]);
    expect(await openIds(notBordering)).toEqual([]);
    expect((await accept(notBordering, serviceRequestId)).statusCode).toBe(404);
    expect((await accept(bordering, serviceRequestId)).statusCode).toBe(200);
  });

  it('does not list a request that is not submitted yet', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const other = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester, { submit: false });

    expect(await openIds(other)).toEqual([]);
    expect((await accept(other, serviceRequestId)).statusCode).toBe(404);
  });

  it('asks a person with no county to choose one', async () => {
    const tenantId = randomUUID();
    const noCounty = await person(tenantId, undefined);
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open',
      headers: noCounty.headers,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe('COUNTY_REQUIRED');
  });

  it('never lists requests across tenants', async () => {
    const requester = await person(randomUUID(), 'SANTA_CLARA', 'requester');
    const elsewhere = await person(randomUUID(), 'SANTA_CLARA');
    await request(requester);
    expect(await openIds(elsewhere)).toEqual([]);
  });
});

describe('accept: first wins', () => {
  it('gives the request to exactly one of two concurrent accepters', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const first = await person(tenantId, 'SANTA_CLARA');
    const second = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);

    const [a, b] = await Promise.all([
      accept(first, serviceRequestId),
      accept(second, serviceRequestId),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);

    const winner = a.statusCode === 200 ? first : second;
    const loser = a.statusCode === 200 ? second : first;
    expect(await openIds(first)).toEqual([]);
    expect(await openIds(second)).toEqual([]);

    const mine = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=mine',
      headers: winner.headers,
    });
    const mineBody: { service_requests: { service_request_id: string }[] } = mine.json();
    expect(mineBody.service_requests.map((r) => r.service_request_id)).toEqual([serviceRequestId]);
    const loserMine = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=mine',
      headers: loser.headers,
    });
    expect(loserMine.json().service_requests).toEqual([]);
  });

  it('answers the winner again with the same assignment, and the late accepter with 409', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const winner = await person(tenantId, 'SANTA_CLARA');
    const late = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);

    const first = await accept(winner, serviceRequestId);
    const replay = await accept(winner, serviceRequestId);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().assignment_id).toBe(first.json().assignment_id);
    expect((await accept(late, serviceRequestId)).statusCode).toBe(409);

    // The chat thread is created with the accept, one per request, between the two people.
    const threads = await pool().query<{ requester_user_id: string; accepted_by_user_id: string }>(
      `SELECT requester_user_id, accepted_by_user_id FROM chat_threads WHERE service_request_id = $1`,
      [serviceRequestId],
    );
    expect(threads.rows).toEqual([
      { requester_user_id: requester.userId, accepted_by_user_id: winner.userId },
    ]);
  });
});

describe('accept: not your own request', () => {
  it('refuses the requester and leaves the request open', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const other = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);

    expect(await openIds(requester)).toEqual([]);
    const refused = await accept(requester, serviceRequestId);
    expect(refused.statusCode).toBe(403);
    expect(await openIds(other)).toEqual([serviceRequestId]);
  });
});

describe('accepter-only commands', () => {
  it('lets the accepter run request and contact commands, and nobody else', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const accepter = await person(tenantId, 'SANTA_CLARA');
    const bystander = await person(tenantId, 'SANTA_CLARA');
    const { caseId, serviceRequestId } = await request(requester);
    expect((await accept(accepter, serviceRequestId)).statusCode).toBe(200);

    const triage = (who: Person) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${serviceRequestId}/commands/TRIAGE`,
        headers: keyed(who),
        payload: {},
      });
    // Someone outside the relationship cannot tell the request exists.
    expect((await triage(bystander)).statusCode).toBe(404);
    // The requester has only the requester's commands.
    expect((await triage(requester)).statusCode).toBe(403);
    const done = await triage(accepter);
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('TRIAGED');

    const logContact = (who: Person) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/cases/${caseId}/commands/log-contact-attempt`,
        headers: keyed(who),
        payload: { channel: 'PHONE' },
      });
    expect((await logContact(bystander)).statusCode).toBe(404);
    expect((await logContact(requester)).statusCode).toBe(403);
    expect((await logContact(accepter)).statusCode).toBe(201);

    // The accepter reads the case; the bystander does not.
    const read = (who: Person) =>
      app.server.inject({ method: 'GET', url: `/api/v0/cases/${caseId}`, headers: who.headers });
    expect((await read(accepter)).statusCode).toBe(200);
    expect((await read(bystander)).statusCode).toBe(404);
  });

  it('still lets the requester cancel their own request', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const accepter = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);
    await accept(accepter, serviceRequestId);

    const cancelled = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${serviceRequestId}/commands/CANCEL`,
      headers: keyed(requester),
      payload: { reason: 'no longer needed' },
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().status).toBe('CANCELLED');
  });
});

describe('GET /api/v0/service-requests pagination', () => {
  it('walks every open request once across pages and caps an oversized limit', async () => {
    const tenantId = randomUUID();
    const viewer = await person(tenantId, 'SANTA_CLARA');
    const expected: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
      expected.push((await request(requester)).serviceRequestId);
    }

    const seen: string[] = [];
    let url = '/api/v0/service-requests?ownership=open&limit=2';
    let pages = 0;
    for (;;) {
      const response = await app.server.inject({ method: 'GET', url, headers: viewer.headers });
      expect(response.statusCode).toBe(200);
      const page: {
        service_requests: { service_request_id: string }[];
        next_cursor: string | null;
      } = response.json();
      seen.push(...page.service_requests.map((item) => item.service_request_id));
      pages += 1;
      if (page.next_cursor === null) break;
      if (pages > 10) throw new Error('cursor did not terminate');
      url = `/api/v0/service-requests?ownership=open&limit=2&cursor=${encodeURIComponent(page.next_cursor)}`;
    }
    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...expected].sort());

    const oversized = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open&limit=101',
      headers: viewer.headers,
    });
    expect(oversized.statusCode).toBe(400);
    const malformed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open&cursor=not-a-real-cursor',
      headers: viewer.headers,
    });
    expect(malformed.statusCode).toBe(400);
  });
});
