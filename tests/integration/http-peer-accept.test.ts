/**
 * Peer accept over /api/v0 (requires PostgreSQL).
 *
 * V1_PROJECT_PLAN.md §2.1 "Peer flow", "County", "Widening" and §4.3 F4-F5:
 * - any signed-in person lists open requests in their county and accepts one;
 * - first accept wins and the request leaves other people's lists;
 * - a requester cannot accept their own request;
 * - only the person who accepted runs the request's accepter commands;
 * - accepting is per request (decided 2026-11-05): two requests of one Veteran can be
 *   held by two different helpers, each seeing only their own.
 * SUAS-specs API.md §5 (cursor pagination), §4 (no existence leakage).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createUser, type ServiceCounty } from '../../src/identity/index.js';
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
  readonly tenantId: string;
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
  return {
    tenantId,
    userId: user.userId,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

function keyed(who: Person): Record<string, string> {
  return { ...who.headers, 'idempotency-key': randomUUID() };
}

/** The requester opens a case and creates a request; `submit` puts it on the open list. */
async function request(requester: Person, options: { submit?: boolean } = {}) {
  // Requesting help needs a passed ID scan; helpers need none.
  await markVerifiedVeteran(pool(), requester.tenantId, requester.userId);
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
    payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
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

  it('answers the winner again with the same answer, and the late accepter with 409', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const winner = await person(tenantId, 'SANTA_CLARA');
    const late = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);

    const first = await accept(winner, serviceRequestId);
    const replay = await accept(winner, serviceRequestId);
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect(first.json()).toMatchObject({ service_request_id: serviceRequestId });
    expect((await accept(late, serviceRequestId)).statusCode).toBe(409);

    // Moving the request past ACCEPTED does not turn the holder's retry into a 404.
    // peerAcceptRequestInTx refuses an already-accepted row, but the HTTP accept
    // returns the same answer first and writes nothing.
    const started = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${serviceRequestId}/commands/START`,
      headers: keyed(winner),
      payload: {},
    });
    expect(started.statusCode).toBe(200);
    const replayAfterStart = await accept(winner, serviceRequestId);
    expect(replayAfterStart.statusCode).toBe(200);
    expect(replayAfterStart.json()).toEqual(first.json());

    const caseId: string = first.json().case_id;
    const audits = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events
        WHERE tenant_id = $1 AND event_type = 'SERVICE_REQUEST_PEER_ACCEPTED'
          AND aggregate_id = $2`,
      [tenantId, serviceRequestId],
    );
    expect(audits.rows[0]?.n).toBe('1');
    const assigned = await pool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM domain_events
        WHERE tenant_id = $1 AND event_type = 'CASE_ASSIGNED' AND aggregate_id = $2`,
      [tenantId, caseId],
    );
    expect(assigned.rows[0]?.n).toBe('1');

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

describe('accept: a request you cannot see does not reveal itself', () => {
  it('answers 404 to an ineligible caller and 409 only to an eligible loser', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const winner = await person(tenantId, 'SANTA_CLARA');
    const eligibleLoser = await person(tenantId, 'SANTA_CLARA');
    const farAway = await person(tenantId, 'MERCED');
    const { serviceRequestId } = await request(requester);

    expect((await accept(winner, serviceRequestId)).statusCode).toBe(200);

    // Someone outside the county gets the answer for a request that does not exist.
    const hidden = await accept(farAway, serviceRequestId);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json().error.code).toBe('NOT_FOUND');
    const missing = await accept(farAway, randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual(hidden.json());

    const lost = await accept(eligibleLoser, serviceRequestId);
    expect(lost.statusCode).toBe(409);
    expect(lost.json().error.code).toBe('ALREADY_CLAIMED');
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
        // Accepting moved the request to ACCEPTED; START is the accepter's next command.
        url: `/api/v0/service-requests/${serviceRequestId}/commands/START`,
        headers: keyed(who),
        payload: {},
      });
    // Someone outside the relationship cannot tell the request exists.
    expect((await triage(bystander)).statusCode).toBe(404);
    // The requester has only the requester's commands.
    expect((await triage(requester)).statusCode).toBe(403);
    const done = await triage(accepter);
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('IN_PROGRESS');

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

  it('does not let another tenant read rows through a cursor from this tenant', async () => {
    const tenantId = randomUUID();
    const viewer = await person(tenantId, 'SANTA_CLARA');
    const ownIds = [
      (await request(await person(tenantId, 'SANTA_CLARA', 'requester'))).serviceRequestId,
      (await request(await person(tenantId, 'SANTA_CLARA', 'requester'))).serviceRequestId,
    ];

    const firstPage = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open&limit=1',
      headers: viewer.headers,
    });
    expect(firstPage.statusCode).toBe(200);
    const cursor: string = firstPage.json().next_cursor;
    expect(cursor).toBeTruthy();

    const otherTenant = randomUUID();
    const outsider = await person(otherTenant, 'SANTA_CLARA');
    await request(await person(otherTenant, 'SANTA_CLARA', 'requester'));
    const crossed = await app.server.inject({
      method: 'GET',
      url: `/api/v0/service-requests?ownership=open&cursor=${encodeURIComponent(cursor)}`,
      headers: outsider.headers,
    });
    expect(crossed.statusCode).toBe(200);
    const ids = (crossed.json().service_requests as { service_request_id: string }[]).map(
      (row) => row.service_request_id,
    );
    for (const ownId of ownIds) expect(ids).not.toContain(ownId);
  });
});

describe('accepting is per request, not per case', () => {
  /** One Veteran with two submitted requests on the one case, and two helpers in the county. */
  async function twoRequests() {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const helperA = await person(tenantId, 'SANTA_CLARA', 'helper-a');
    const helperB = await person(tenantId, 'SANTA_CLARA', 'helper-b');
    const bystander = await person(tenantId, 'SANTA_CLARA', 'bystander');
    const first = await request(requester);
    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${first.caseId}/service-requests`,
      headers: keyed(requester),
      payload: {
        category: 'TRANSPORTATION',
        details: { summary: 'A ride to the clinic', meeting_place: 'Clinic front desk' },
      },
    });
    expect(created.statusCode).toBe(201);
    const secondId: string = created.json().service_request_id;
    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${secondId}/commands/SUBMIT`,
      headers: keyed(requester),
      payload: {},
    });
    expect(submitted.statusCode).toBe(200);
    return {
      tenantId,
      requester,
      helperA,
      helperB,
      bystander,
      caseId: first.caseId,
      firstId: first.serviceRequestId,
      secondId,
    };
  }

  const get = (who: Person, url: string) =>
    app.server.inject({ method: 'GET', url: `/api/v0${url}`, headers: who.headers });

  it('puts a later request of a held case on the open list for another helper', async () => {
    const { helperA, helperB, firstId, secondId } = await twoRequests();
    expect((await accept(helperA, firstId)).statusCode).toBe(200);

    // The first request left everyone's list; the second is still open to both.
    expect(await openIds(helperB)).toEqual([secondId]);
    expect(await openIds(helperA)).toEqual([secondId]);
  });

  it('lets two helpers hold two requests of the same Veteran', async () => {
    const { helperA, helperB, caseId, firstId, secondId } = await twoRequests();
    const a = await accept(helperA, firstId);
    const b = await accept(helperB, secondId);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ case_id: caseId, case_status: 'ASSIGNED' });
    expect(b.json()).toMatchObject({ case_id: caseId, case_status: 'ASSIGNED' });
    expect(await openIds(helperA)).toEqual([]);
  });

  it('shows each helper only their own request, in the list and in detail', async () => {
    const { requester, helperA, helperB, firstId, secondId } = await twoRequests();
    await accept(helperA, firstId);
    await accept(helperB, secondId);

    const mine = async (who: Person) =>
      (
        (await get(who, '/service-requests?ownership=mine')).json().service_requests as {
          service_request_id: string;
          counterpart_display_name: string | null;
        }[]
      ).map((item) => item.service_request_id);
    expect(await mine(helperA)).toEqual([firstId]);
    expect(await mine(helperB)).toEqual([secondId]);

    const ownDetail = await get(helperA, `/service-requests/${firstId}`);
    expect(ownDetail.statusCode).toBe(200);
    expect(ownDetail.json()).toMatchObject({
      viewer_role: 'ACCEPTER',
      meeting_place: 'Main Street library',
    });
    // The other helper's request, on the same Veteran's case, does not exist to them.
    expect((await get(helperA, `/service-requests/${secondId}`)).statusCode).toBe(404);
    expect((await get(helperB, `/service-requests/${firstId}`)).statusCode).toBe(404);

    // The requester sees both, each with its own helper.
    await pool().query(`UPDATE users SET display_name = 'Dee R.' WHERE user_id = $1`, [
      helperA.userId,
    ]);
    await pool().query(`UPDATE users SET display_name = 'Sam K.' WHERE user_id = $1`, [
      helperB.userId,
    ]);
    const asRequester = async (id: string): Promise<string | null> => {
      const body: { counterpart_display_name: string | null } = (
        await get(requester, `/service-requests/${id}`)
      ).json();
      return body.counterpart_display_name;
    };
    expect(await asRequester(firstId)).toBe('Dee R.');
    expect(await asRequester(secondId)).toBe('Sam K.');

    // The case's request list is narrowed the same way for a helper.
    const caseList = async (who: Person, caseId: string) =>
      (
        (await get(who, `/cases/${caseId}/service-requests`)).json().service_requests as {
          service_request_id: string;
        }[]
      ).map((item) => item.service_request_id);
    const caseId = ownDetail.json().case_id as string;
    expect(await caseList(helperA, caseId)).toEqual([firstId]);
    expect((await caseList(requester, caseId)).sort()).toEqual([firstId, secondId].sort());
  });

  it("runs a request command only for that request's holder", async () => {
    const { helperA, helperB, firstId, secondId } = await twoRequests();
    await accept(helperA, firstId);
    await accept(helperB, secondId);

    const start = (who: Person, id: string) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${id}/commands/START`,
        headers: keyed(who),
        payload: {},
      });
    expect((await start(helperA, secondId)).statusCode).toBe(404);
    expect((await start(helperB, firstId)).statusCode).toBe(404);
    expect((await start(helperA, firstId)).json().status).toBe('IN_PROGRESS');
    expect((await start(helperB, secondId)).json().status).toBe('IN_PROGRESS');
  });

  it('gives each helper chat with the Veteran for their own request only', async () => {
    const { requester, helperA, helperB, bystander, firstId, secondId } = await twoRequests();
    await accept(helperA, firstId);
    await accept(helperB, secondId);

    const send = (who: Person, id: string, body: string) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${id}/chat/messages`,
        headers: keyed(who),
        payload: { body },
      });
    expect((await send(helperA, firstId, 'A here')).statusCode).toBe(201);
    expect((await send(helperB, secondId, 'B here')).statusCode).toBe(201);
    // Each helper is shut out of the other's thread, whoever the Veteran is.
    expect((await send(helperA, secondId, 'let me in')).statusCode).toBe(404);
    expect((await send(helperB, firstId, 'let me in')).statusCode).toBe(404);
    expect((await get(helperA, `/service-requests/${secondId}/chat/messages`)).statusCode).toBe(
      404,
    );
    expect((await send(bystander, firstId, 'hello')).statusCode).toBe(404);

    const threadIds = async (who: Person) =>
      ((await get(who, '/chat/threads')).json().threads as { service_request_id: string }[])
        .map((thread) => thread.service_request_id)
        .sort();
    expect(await threadIds(helperA)).toEqual([firstId]);
    expect(await threadIds(helperB)).toEqual([secondId]);
    expect(await threadIds(requester)).toEqual([firstId, secondId].sort());
  });

  it('answers 409 to a second accept of a held request and 404 to an ineligible caller', async () => {
    const { tenantId, helperA, helperB, firstId, secondId } = await twoRequests();
    const faraway = await person(tenantId, 'MERCED', 'faraway');
    expect((await accept(helperA, firstId)).statusCode).toBe(200);

    // Even though helperA holds the other request, helperB can still lose this one.
    expect((await accept(helperB, firstId)).statusCode).toBe(409);
    expect((await accept(helperB, firstId)).json().error.code).toBe('ALREADY_CLAIMED');
    // A person outside the county learns nothing, held or not.
    expect((await accept(faraway, firstId)).statusCode).toBe(404);
    expect((await accept(faraway, secondId)).statusCode).toBe(404);
  });

  it('allows case-level actions only to a helper who holds a request of the case', async () => {
    const { requester, helperA, helperB, bystander, caseId, firstId, secondId } =
      await twoRequests();
    await accept(helperA, firstId);

    const logContact = (who: Person) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/cases/${caseId}/commands/log-contact-attempt`,
        headers: keyed(who),
        payload: { channel: 'PHONE' },
      });
    // helperB holds nothing here yet, so the case does not exist to them.
    expect((await logContact(helperB)).statusCode).toBe(404);
    expect((await logContact(bystander)).statusCode).toBe(404);
    expect((await logContact(requester)).statusCode).toBe(403);
    expect((await logContact(helperA)).statusCode).toBe(201);

    // Holding any one request is enough, and it is the same for each holder.
    await accept(helperB, secondId);
    expect((await logContact(helperB)).statusCode).toBe(201);
    const attempts = await get(helperB, `/cases/${caseId}/contact-attempts`);
    expect(attempts.statusCode).toBe(200);
    expect(attempts.json().contact_attempts).toHaveLength(2);

    const activate = (who: Person) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/cases/${caseId}/commands/activate`,
        headers: keyed(who),
        payload: {},
      });
    expect((await activate(bystander)).statusCode).toBe(404);
    expect((await activate(requester)).statusCode).toBe(403);
    expect((await activate(helperB)).statusCode).toBe(200);
  });
});

describe('GET /api/v0/service-requests?ownership=mine counts', () => {
  const get = (who: Person, url: string) =>
    app.server.inject({ method: 'GET', url: `/api/v0${url}`, headers: who.headers });

  it('counts the helper active and recently closed requests, for ownership=mine only', async () => {
    const tenantId = randomUUID();
    const helper = await person(tenantId, 'SANTA_CLARA', 'helper');
    const other = await person(tenantId, 'SANTA_CLARA', 'other-helper');
    const active = await request(await person(tenantId, 'SANTA_CLARA', 'requester-a'));
    const recent = await request(await person(tenantId, 'SANTA_CLARA', 'requester-b'));
    const old = await request(await person(tenantId, 'SANTA_CLARA', 'requester-c'));
    const cancelled = await request(await person(tenantId, 'SANTA_CLARA', 'requester-e'));
    const others = await request(await person(tenantId, 'SANTA_CLARA', 'requester-d'));
    for (const { serviceRequestId } of [active, recent, old, cancelled]) {
      expect((await accept(helper, serviceRequestId)).statusCode).toBe(200);
    }
    expect((await accept(other, others.serviceRequestId)).statusCode).toBe(200);
    const setTerminal = (id: string, status: string, ago: string) =>
      pool().query(
        `UPDATE service_requests
            SET status = $2::suas_service_request_status, terminal_at = now() - $3::interval
          WHERE service_request_id = $1`,
        [id, status, ago],
      );
    await setTerminal(recent.serviceRequestId, 'CLOSED', '1 day');
    await setTerminal(old.serviceRequestId, 'CLOSED', '45 days');
    // Cancelled is not counted as closed (suas-specs #69 R7.3, D-057).
    await setTerminal(cancelled.serviceRequestId, 'CANCELLED', '1 day');
    await setTerminal(others.serviceRequestId, 'CLOSED', '0 seconds');

    const mine = await get(helper, '/service-requests?ownership=mine&limit=1');
    expect(mine.statusCode).toBe(200);
    expect(mine.json().counts).toEqual({ helping_now: 1, closed_last_30_days: 1 });
    expect(mine.json().service_requests).toHaveLength(1);

    expect((await get(helper, '/service-requests?ownership=open')).json()).not.toHaveProperty(
      'counts',
    );
    expect((await get(helper, '/service-requests?ownership=requested')).json()).not.toHaveProperty(
      'counts',
    );
  });

  it('counts closes inside the rolling 30-day window and not just outside it', async () => {
    const tenantId = randomUUID();
    const helper = await person(tenantId, 'SANTA_CLARA', 'helper');
    const inside = await request(await person(tenantId, 'SANTA_CLARA', 'requester-a'));
    const outside = await request(await person(tenantId, 'SANTA_CLARA', 'requester-b'));
    for (const { serviceRequestId } of [inside, outside]) {
      expect((await accept(helper, serviceRequestId)).statusCode).toBe(200);
    }
    await pool().query(
      `UPDATE service_requests SET status = 'CLOSED',
              terminal_at = now() - interval '30 days' + interval '1 minute'
        WHERE service_request_id = $1`,
      [inside.serviceRequestId],
    );
    await pool().query(
      `UPDATE service_requests SET status = 'CLOSED',
              terminal_at = now() - interval '30 days' - interval '1 minute'
        WHERE service_request_id = $1`,
      [outside.serviceRequestId],
    );
    const mine = await get(helper, '/service-requests?ownership=mine');
    expect(mine.json().counts).toEqual({ helping_now: 0, closed_last_30_days: 1 });
  });

  it('follows real CANCEL and CLOSE commands through the API', async () => {
    const tenantId = randomUUID();
    const helper = await person(tenantId, 'SANTA_CLARA', 'helper');
    const requesterA = await person(tenantId, 'SANTA_CLARA', 'requester-a');
    const requesterB = await person(tenantId, 'SANTA_CLARA', 'requester-b');
    const toCancel = await request(requesterA);
    const toClose = await request(requesterB);
    for (const { serviceRequestId } of [toCancel, toClose]) {
      expect((await accept(helper, serviceRequestId)).statusCode).toBe(200);
    }
    const counts = async (): Promise<unknown> => {
      const body: { counts?: unknown } = (
        await get(helper, '/service-requests?ownership=mine')
      ).json();
      return body.counts;
    };
    expect(await counts()).toEqual({ helping_now: 2, closed_last_30_days: 0 });

    const command = (who: Person, id: string, name: string, payload: object = {}) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${id}/commands/${name}`,
        headers: keyed(who),
        payload,
      });
    const cancel = await command(requesterA, toCancel.serviceRequestId, 'CANCEL', {
      reason: 'No longer needed',
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(await counts()).toEqual({ helping_now: 1, closed_last_30_days: 0 });

    for (const [who, name] of [
      [helper, 'START'],
      [helper, 'FULFILL'],
      [requesterB, 'CONFIRM'],
    ] as const) {
      const step = await command(who, toClose.serviceRequestId, name);
      expect(step.statusCode, `${name}: ${step.body}`).toBe(200);
    }
    // CONFIRMED waits for the helper's CLOSE, so it still counts as helping now.
    expect(await counts()).toEqual({ helping_now: 1, closed_last_30_days: 0 });
    const close = await command(helper, toClose.serviceRequestId, 'CLOSE');
    expect(close.statusCode, close.body).toBe(200);
    expect(await counts()).toEqual({ helping_now: 0, closed_last_30_days: 1 });

    const stamped = await pool().query<{ terminal_at: Date | null }>(
      'SELECT terminal_at FROM service_requests WHERE service_request_id = ANY($1::uuid[])',
      [[toCancel.serviceRequestId, toClose.serviceRequestId]],
    );
    expect(stamped.rows.every((row) => row.terminal_at !== null)).toBe(true);
  });
});

describe('accepted_at', () => {
  const get = (who: Person, url: string) =>
    app.server.inject({ method: 'GET', url: `/api/v0${url}`, headers: who.headers });

  it('shows when a request was accepted to its requester and accepter only', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const accepter = await person(tenantId, 'SANTA_CLARA');
    const bystander = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);

    const detailOf = (who: Person) => get(who, `/service-requests/${serviceRequestId}`);
    expect((await detailOf(requester)).json().accepted_at).toBeNull();

    expect((await accept(accepter, serviceRequestId)).statusCode).toBe(200);
    const stored = await pool().query<{ created_at: Date }>(
      `SELECT created_at FROM chat_threads WHERE service_request_id = $1`,
      [serviceRequestId],
    );
    const acceptedAt = stored.rows[0]?.created_at.toISOString();
    expect(acceptedAt).toBeDefined();

    expect((await detailOf(requester)).json().accepted_at).toBe(acceptedAt);
    expect((await detailOf(accepter)).json().accepted_at).toBe(acceptedAt);
    const hidden = await detailOf(bystander);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).not.toHaveProperty('accepted_at');

    for (const who of [requester, accepter]) {
      const threads: { threads: { accepted_at: string }[] } = (
        await get(who, '/chat/threads')
      ).json();
      expect(threads.threads.map((thread) => thread.accepted_at)).toEqual([acceptedAt]);
    }
    expect((await get(bystander, '/chat/threads')).json().threads).toEqual([]);
  });

  it('returns null, not a made-up time, for an accepted request with no recorded accept time', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SANTA_CLARA', 'requester');
    const accepter = await person(tenantId, 'SANTA_CLARA');
    const { serviceRequestId } = await request(requester);
    expect((await accept(accepter, serviceRequestId)).statusCode).toBe(200);
    // A request backfilled by migration 0017 has an accepter but no chat thread.
    await pool().query('DELETE FROM chat_threads WHERE service_request_id = $1', [
      serviceRequestId,
    ]);
    const detail = await get(requester, `/service-requests/${serviceRequestId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('ACCEPTED');
    expect(detail.json().accepted_at).toBeNull();
  });
});
