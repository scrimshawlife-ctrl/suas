/**
 * 30-minute widening (requires PostgreSQL).
 *
 * V1_PROJECT_PLAN.md §2.1 "Widening" and §4.3 F6: an unaccepted request widens once
 * to the bordering counties after the stored delay; an accepted or cancelled request
 * never widens; a widened request is visible and acceptable in a bordering county.
 * AGENTS.md rule 9: the job is replay-safe.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { widenDueRequests } from '../../src/coordination/widening.js';
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
  readonly userId: string;
  readonly headers: Record<string, string>;
}

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

async function person(tenantId: string, county: ServiceCounty): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`widen-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county,
  });
  // Requesting needs a passed scan; the chosen county is kept.
  await markVerifiedVeteran(pool(), tenantId, user.userId, county);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return { userId: user.userId, headers: { authorization: `Bearer ${session.credential}` } };
}

function keyed(who: Person): Record<string, string> {
  return { ...who.headers, 'idempotency-key': randomUUID() };
}

/** A submitted request whose submission is `waitedMinutes` before `now`. */
async function submittedRequest(requester: Person, now: Date, waitedMinutes: number) {
  const opened = await app.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  // 201 opens a new case; 200 returns the requester's already-open case.
  expect([200, 201]).toContain(opened.statusCode);
  const caseId: string = opened.json().case_id;
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${caseId}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD' },
  });
  expect(created.statusCode).toBe(201);
  const serviceRequestId: string = created.json().service_request_id;
  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${serviceRequestId}/commands/SUBMIT`,
    headers: keyed(requester),
    payload: {},
  });
  expect(submitted.statusCode).toBe(200);
  await pool().query(
    `UPDATE service_requests SET submitted_at = $2 WHERE service_request_id = $1`,
    [serviceRequestId, new Date(now.getTime() - waitedMinutes * 60_000)],
  );
  return serviceRequestId;
}

async function widenedAt(serviceRequestId: string): Promise<Date | null> {
  const result = await pool().query<{ widened_at: Date | null }>(
    `SELECT widened_at FROM service_requests WHERE service_request_id = $1`,
    [serviceRequestId],
  );
  return result.rows[0]?.widened_at ?? null;
}

async function openItems(who: Person) {
  const response = await app.server.inject({
    method: 'GET',
    url: '/api/v0/service-requests?ownership=open',
    headers: who.headers,
  });
  expect(response.statusCode).toBe(200);
  const body: { service_requests: { service_request_id: string; widened: boolean }[] } =
    response.json();
  return body.service_requests;
}

describe('the delay boundary', () => {
  it('widens after the stored delay and not before it', async () => {
    const now = new Date();
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SAN_MATEO');
    const tooSoon = await submittedRequest(requester, now, 29);
    const due = await submittedRequest(requester, now, 31);

    const result = await widenDueRequests(pool(), { now });

    expect(result.delayMinutes).toBe(30);
    const ids = result.widened.map((item) => item.serviceRequestId);
    expect(ids).toContain(due);
    expect(ids).not.toContain(tooSoon);
    expect(await widenedAt(tooSoon)).toBeNull();
    expect(await widenedAt(due)).not.toBeNull();
  });

  it('reads the delay from the stored setting', async () => {
    const now = new Date();
    const requester = await person(randomUUID(), 'SAN_MATEO');
    const waited = await submittedRequest(requester, now, 31);

    await pool().query(
      `UPDATE app_settings SET value = '45'::jsonb WHERE setting_key = 'widening_delay_minutes'`,
    );
    try {
      await widenDueRequests(pool(), { now });
      expect(await widenedAt(waited)).toBeNull();
    } finally {
      await pool().query(
        `UPDATE app_settings SET value = '30'::jsonb WHERE setting_key = 'widening_delay_minutes'`,
      );
    }

    await widenDueRequests(pool(), { now });
    expect(await widenedAt(waited)).not.toBeNull();
  });
});

describe('who can see a widened request', () => {
  it('reaches bordering counties only (Merced does not), marks the request widened, and audits it', async () => {
    const now = new Date();
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SAN_MATEO');
    const ownCounty = await person(tenantId, 'SAN_MATEO');
    const bordering = await person(tenantId, 'SANTA_CRUZ');
    const notBordering = await person(tenantId, 'MERCED');
    // A water-only border counts as bordering (owner decision), so Alameda reaches too.
    const acrossBay = await person(tenantId, 'ALAMEDA');
    const serviceRequestId = await submittedRequest(requester, now, 31);

    expect(await openItems(bordering)).toEqual([]);
    await widenDueRequests(pool(), { now });

    expect(await openItems(bordering)).toEqual([
      expect.objectContaining({ service_request_id: serviceRequestId, widened: true }),
    ]);
    expect(await openItems(ownCounty)).toEqual([
      expect.objectContaining({ service_request_id: serviceRequestId, widened: true }),
    ]);
    expect(await openItems(notBordering)).toEqual([]);
    expect(await openItems(acrossBay)).toEqual([
      expect.objectContaining({ service_request_id: serviceRequestId, widened: true }),
    ]);

    const audit = await pool().query<{ payload: { reached_counties: string[] } }>(
      `SELECT payload FROM audit_events
        WHERE event_type = 'SERVICE_REQUEST_WIDENED' AND target_id = $1`,
      [serviceRequestId],
    );
    expect(audit.rows).toHaveLength(1);
    expect([...(audit.rows[0]?.payload.reached_counties ?? [])].sort()).toEqual([
      'ALAMEDA',
      'SANTA_CLARA',
      'SANTA_CRUZ',
    ]);
  });

  it('lets a person in a bordering county accept it, and the first accept wins', async () => {
    const now = new Date();
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SAN_MATEO');
    const ownCounty = await person(tenantId, 'SAN_MATEO');
    const bordering = await person(tenantId, 'SANTA_CLARA');
    const serviceRequestId = await submittedRequest(requester, now, 31);
    const accept = (who: Person) =>
      app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${serviceRequestId}/accept`,
        headers: who.headers,
      });

    expect((await accept(bordering)).statusCode).toBe(404);
    await widenDueRequests(pool(), { now });
    expect((await accept(bordering)).statusCode).toBe(200);
    expect((await accept(ownCounty)).statusCode).toBe(409);
    expect(await openItems(ownCounty)).toEqual([]);
  });
});

describe('requests that never widen', () => {
  it('skips an accepted request and a cancelled request', async () => {
    const now = new Date();
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'SAN_MATEO');
    const accepter = await person(tenantId, 'SAN_MATEO');
    const accepted = await submittedRequest(requester, now, 31);
    const cancelled = await submittedRequest(requester, now, 31);

    const accept = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${accepted}/accept`,
      headers: accepter.headers,
    });
    expect(accept.statusCode).toBe(200);
    const cancel = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${cancelled}/commands/CANCEL`,
      headers: keyed(requester),
      payload: { reason: 'no longer needed' },
    });
    expect(cancel.statusCode).toBe(200);

    await widenDueRequests(pool(), { now });

    expect(await widenedAt(accepted)).toBeNull();
    expect(await widenedAt(cancelled)).toBeNull();
  });
});

describe('replay', () => {
  it('widens once: a second run changes nothing and writes no second audit event', async () => {
    const now = new Date();
    const requester = await person(randomUUID(), 'SAN_MATEO');
    const serviceRequestId = await submittedRequest(requester, now, 31);

    await widenDueRequests(pool(), { now });
    const first = await widenedAt(serviceRequestId);
    const replay = await widenDueRequests(pool(), { now: new Date(now.getTime() + 3_600_000) });

    expect(replay.widened.map((item) => item.serviceRequestId)).not.toContain(serviceRequestId);
    expect(await widenedAt(serviceRequestId)).toEqual(first);
    const audit = await pool().query(
      `SELECT 1 FROM audit_events
        WHERE event_type = 'SERVICE_REQUEST_WIDENED' AND target_id = $1`,
      [serviceRequestId],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('lets two overlapping first runs widen a request exactly once', async () => {
    const now = new Date();
    const requester = await person(randomUUID(), 'SAN_MATEO');
    const serviceRequestId = await submittedRequest(requester, now, 31);

    const runs = await Promise.all([
      widenDueRequests(pool(), { now }),
      widenDueRequests(pool(), { now }),
    ]);

    const hits = runs
      .flatMap((run) => run.widened)
      .filter((w) => w.serviceRequestId === serviceRequestId);
    expect(hits).toHaveLength(1);
    const audit = await pool().query(
      `SELECT 1 FROM audit_events
        WHERE event_type = 'SERVICE_REQUEST_WIDENED' AND target_id = $1`,
      [serviceRequestId],
    );
    expect(audit.rowCount).toBe(1);
  });
});
