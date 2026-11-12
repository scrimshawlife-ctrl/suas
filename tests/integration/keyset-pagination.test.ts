/**
 * API.md §5 keyset paging on the lists that share src/http/cursor.ts.
 *
 * Rows that differ only below the millisecond must all appear across pages (A4-09): a JS
 * `Date` cursor used to skip them. `GET /notifications` and `GET /chat/threads` page with
 * `cursor` + `limit` (default 20) and return `next_cursor` (C-09). The helper's 30-day
 * count is 720 hours whatever the session time zone (A2-18, DISPATCH.md §14.2).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { readHelperRequestCounts } from '../../src/coordination/index.js';
import { createResource, searchResources } from '../../src/fulfillment/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { holdRequest } from '../helpers/hold-case.js';
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

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

interface Person {
  readonly tenantId: string;
  readonly userId: string;
  readonly headers: Record<string, string>;
}

async function person(tenantId: string, label: string): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
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

/** A submitted FOOD request from `requester`, on the open list of their county. */
async function submittedRequest(requester: Person): Promise<string> {
  await markVerifiedVeteran(pool(), requester.tenantId, requester.userId);
  const call = (url: string, payload?: object) =>
    app.server.inject({
      method: 'POST',
      url: `/api/v0${url}`,
      headers: { ...requester.headers, 'idempotency-key': randomUUID() },
      ...(payload !== undefined ? { payload } : {}),
    });
  const caseId: string = (await call('/cases')).json().case_id;
  const created = await call(`/cases/${caseId}/service-requests`, {
    category: 'FOOD',
    details: { meeting_place: 'Main Street library' },
  });
  const serviceRequestId: string = created.json().service_request_id;
  expect((await call(`/service-requests/${serviceRequestId}/commands/SUBMIT`, {})).statusCode).toBe(
    200,
  );
  return serviceRequestId;
}

/** Follows `next_cursor` from `firstUrl` to the end; returns every page's ids. */
async function walk(
  who: Person,
  firstUrl: string,
  listKey: string,
  idKey: string,
): Promise<{ pages: string[][]; firstBody: Record<string, unknown> }> {
  const pages: string[][] = [];
  let firstBody: Record<string, unknown> = {};
  let url = firstUrl;
  for (;;) {
    const response = await app.server.inject({ method: 'GET', url, headers: who.headers });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    if (pages.length === 0) firstBody = body;
    pages.push((body[listKey] as Record<string, string>[]).map((row) => row[idKey] as string));
    const next = body.next_cursor as string | null;
    if (next === null) break;
    if (pages.length > 30) throw new Error('cursor did not terminate');
    const separator = firstUrl.includes('?') ? '&' : '?';
    url = `${firstUrl}${separator}cursor=${encodeURIComponent(next)}`;
  }
  return { pages, firstBody };
}

// One millisecond, three distinct microsecond values: newest first is a, b, c.
const SAME_MS = [
  '2026-11-01T10:00:00.123900Z',
  '2026-11-01T10:00:00.123500Z',
  '2026-11-01T10:00:00.123100Z',
];

describe('sub-millisecond rows are never skipped between pages (A4-09)', () => {
  it('open requests', async () => {
    const tenantId = randomUUID();
    const viewer = await person(tenantId, 'viewer');
    const ids: string[] = [];
    for (const at of SAME_MS) {
      const id = await submittedRequest(await person(tenantId, 'requester'));
      await pool().query(
        `UPDATE service_requests SET created_at = $2 WHERE service_request_id = $1`,
        [id, at],
      );
      ids.push(id);
    }
    const { pages } = await walk(
      viewer,
      '/api/v0/service-requests?ownership=open&limit=1',
      'service_requests',
      'service_request_id',
    );
    expect(pages.flat()).toEqual(ids);
  });

  it('resources', async () => {
    const tenantId = randomUUID();
    const ids: string[] = [];
    for (const at of SAME_MS) {
      const created = await createResource(pool(), {
        tenantId,
        serviceName: `Pantry ${at}`,
        category: 'FOOD',
      });
      await pool().query(
        `UPDATE resources SET active = true, last_verified_at = $2, verification_source = 'synthetic-test'
          WHERE resource_id = $1`,
        [created.resourceId, at],
      );
      ids.push(created.resourceId);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await searchResources(
        pool(),
        tenantId,
        { activeOnly: true },
        { limit: 1, ...(cursor !== undefined ? { cursor } : {}) },
      );
      seen.push(...result.results.map((row) => row.resource.resourceId));
      cursor = result.nextCursor;
      if (cursor === undefined) break;
    }
    expect(seen).toEqual(ids);
  });
});

describe('GET /api/v0/notifications paging (C-09)', () => {
  it('returns 20 by default with next_cursor, and walks every notification once', async () => {
    const tenantId = randomUUID();
    const recipient = await person(tenantId, 'recipient');
    const ids: string[] = [];
    for (let index = 0; index < 22; index += 1) {
      const id = randomUUID();
      // The last three share one millisecond.
      const at =
        index < 19
          ? `2026-10-${String(10 + index).padStart(2, '0')}T09:00:00Z`
          : SAME_MS[21 - index];
      await pool().query(
        `INSERT INTO notifications
           (notification_id, tenant_id, recipient_user_id, reason, channel, consent_basis,
            template_version, created_at)
         VALUES ($1, $2, $3, 'service_request_accepted', 'IN_APP', 'test', 'v1', $4)`,
        [id, tenantId, recipient.userId, at],
      );
      ids.push(id);
    }

    const { pages, firstBody } = await walk(
      recipient,
      '/api/v0/notifications',
      'notifications',
      'notification_id',
    );
    expect(firstBody.limit).toBe(20);
    expect(pages.map((page) => page.length)).toEqual([20, 2]);
    expect(pages.flat()).toEqual([...ids].reverse());

    const small = await walk(
      recipient,
      '/api/v0/notifications?limit=1',
      'notifications',
      'notification_id',
    );
    expect(small.pages.flat()).toEqual([...ids].reverse());

    const bad = await app.server.inject({
      method: 'GET',
      url: '/api/v0/notifications?cursor=nope',
      headers: recipient.headers,
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('GET /api/v0/chat/threads paging (C-09)', () => {
  it('pages by latest activity and returns next_cursor', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const helper = await person(tenantId, 'helper');
    const requestIds: string[] = [];
    for (const at of SAME_MS) {
      const serviceRequestId = await submittedRequest(requester);
      await holdRequest(pool(), { tenantId, serviceRequestId, acceptedByUserId: helper.userId });
      await pool().query(`UPDATE chat_threads SET created_at = $2 WHERE service_request_id = $1`, [
        serviceRequestId,
        at,
      ]);
      requestIds.push(serviceRequestId);
    }

    for (const who of [requester, helper]) {
      const { pages, firstBody } = await walk(
        who,
        '/api/v0/chat/threads?limit=1',
        'threads',
        'service_request_id',
      );
      expect(pages.flat()).toEqual(requestIds);
      expect(typeof firstBody.next_cursor).toBe('string');
    }
    const all = await walk(requester, '/api/v0/chat/threads', 'threads', 'service_request_id');
    expect(all.pages).toEqual([requestIds]);
    expect(all.firstBody.next_cursor).toBeNull();
  });
});

/** Julian day 1..365 (Feb 29 never counted), as a POSIX `Jn` rule uses it. */
function julianDay(date: Date): number {
  const sameDayIn2025 = Date.UTC(2025, date.getUTCMonth(), date.getUTCDate());
  return Math.round((sameDayIn2025 - Date.UTC(2025, 0, 1)) / 86_400_000) + 1;
}

describe('closed_last_30_days ignores the session time zone (A2-18)', () => {
  it('counts 720 hours back even when a DST change falls inside the window', async () => {
    const tenantId = randomUUID();
    const helper = await person(tenantId, 'helper');
    const inside = await submittedRequest(await person(tenantId, 'requester-a'));
    const outside = await submittedRequest(await person(tenantId, 'requester-b'));
    for (const serviceRequestId of [inside, outside]) {
      await holdRequest(pool(), { tenantId, serviceRequestId, acceptedByUserId: helper.userId });
    }
    const close = (id: string, ago: string) =>
      pool().query(
        `UPDATE service_requests SET status = 'CLOSED', terminal_at = now() - $2::interval
          WHERE service_request_id = $1`,
        [id, ago],
      );
    await close(inside, '719 hours 30 minutes');
    await close(outside, '720 hours 30 minutes');

    // A synthetic zone that moved its clocks forward 15 days ago: there, "30 days" is 719 h.
    const day = 86_400_000;
    const zone = `AAA0BBB,J${julianDay(new Date(Date.now() - 15 * day))}/0,J${julianDay(new Date(Date.now() + 15 * day))}/0`;
    const client = await pool().connect();
    try {
      await client.query(`SET TIME ZONE '${zone}'`);
      const shift = await client.query<{ hours: number }>(
        `SELECT extract(epoch FROM (now() - interval '720 hours') - (now() - interval '30 days')) / 3600 AS hours`,
      );
      expect(Number(shift.rows[0]?.hours)).toBe(-1);
      expect(await readHelperRequestCounts(client, tenantId, helper.userId)).toEqual({
        helpingNow: 0,
        closedLast30Days: 1,
      });
    } finally {
      await client.query('RESET TIME ZONE');
      client.release();
    }
  });
});
