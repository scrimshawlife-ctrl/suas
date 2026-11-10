/**
 * Requester edit, ride destination and the case-owner create guard (requires PostgreSQL).
 *
 * V1_MVP_PROPOSAL.md Round 8: R8.1 (edit before accept), R8.3 (only the requester adds a
 * need to a case), R8.7 (optional `destination` on TRANSPORTATION, visible to the requester
 * and the accepter only). DISPATCH.md §13.4 for the meeting-place visibility rule it mirrors.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
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
  readonly tenantId: string;
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

function keyed(who: Person, key: string = randomUUID()): Record<string, string> {
  return { ...who.headers, 'idempotency-key': key };
}

/** The requester submits through the plain form, which leaves the request SUBMITTED. */
async function submit(requester: Person, payload: Record<string, unknown>) {
  await markVerifiedVeteran(pool(), requester.tenantId, requester.userId);
  const response = await app.server.inject({
    method: 'POST',
    url: '/api/v0/service-requests',
    headers: keyed(requester),
    payload,
  });
  return {
    response,
    id: response.json().service_request_id as string,
    caseId: response.json().case_id as string,
  };
}

const FOOD = { category: 'FOOD', summary: 'Groceries', meeting_place: 'Main Street library' };
const RIDE = {
  category: 'TRANSPORTATION',
  summary: 'Ride to an appointment',
  meeting_place: 'Front entrance',
  destination: 'County clinic, 4th floor',
};

function edit(who: Person, id: string, payload: Record<string, unknown>, key?: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/commands/edit`,
    headers: keyed(who, key),
    payload,
  });
}

function detail(who: Person, id: string) {
  return app.server.inject({
    method: 'GET',
    url: `/api/v0/service-requests/${id}`,
    headers: who.headers,
  });
}

function accept(who: Person, id: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/accept`,
    headers: who.headers,
  });
}

describe('requester edit before accept (R8.1)', () => {
  it('updates the fields, clears one with null, and returns the detail', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const { id } = await submit(requester, { ...FOOD, timing: 'Friday' });

    const changed = await edit(requester, id, {
      summary: 'Groceries for the week',
      timing: null,
      meeting_place: 'Oak Street church',
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({
      service_request_id: id,
      viewer_role: 'REQUESTER',
      summary: 'Groceries for the week',
      timing: null,
      meeting_place: 'Oak Street church',
      destination: null,
      replayed: false,
    });
    const read = await detail(requester, id);
    expect(read.json()).toMatchObject({ summary: 'Groceries for the week', timing: null });
  });

  it('refuses a helper, hides it from a bystander, and refuses after accept', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const helper = await person(tenantId, 'helper');
    const bystander = await person(tenantId, 'bystander');
    const { id } = await submit(requester, FOOD);

    expect((await edit(bystander, id, { summary: 'Changed' })).statusCode).toBe(404);
    expect((await accept(helper, id)).statusCode).toBe(200);

    expect((await edit(helper, id, { summary: 'Changed' })).statusCode).toBe(403);
    expect((await edit(bystander, id, { summary: 'Changed' })).statusCode).toBe(404);
    const late = await edit(requester, id, { summary: 'Changed' });
    expect(late.statusCode).toBe(409);
    expect(late.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await detail(requester, id)).json().summary).toBe('Groceries');
  });

  it('replays the same key once and keeps the text out of the audit event', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const { id } = await submit(requester, FOOD);
    const key = randomUUID();

    const first = await edit(requester, id, { summary: 'Secret groceries text' }, key);
    const again = await edit(requester, id, { summary: 'Secret groceries text' }, key);
    expect(first.json().replayed).toBe(false);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ replayed: true, summary: 'Secret groceries text' });

    const events = await pool().query<{ payload: unknown }>(
      `SELECT payload FROM audit_events
        WHERE target_id = $1 AND event_type = 'SERVICE_REQUEST_EDITED'`,
      [id],
    );
    expect(events.rowCount).toBe(1);
    expect(JSON.stringify(events.rows[0]?.payload)).not.toContain('Secret');

    const other = await edit(requester, id, { summary: 'A different edit' }, key);
    expect(other.statusCode).toBe(409);
  });

  it('keeps the meeting place required for FOOD and needs a key and a field', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const { id } = await submit(requester, FOOD);

    const cleared = await edit(requester, id, { meeting_place: null });
    expect(cleared.statusCode).toBe(422);
    expect(cleared.json().error.code).toBe('UNPROCESSABLE');
    expect((await detail(requester, id)).json().meeting_place).toBe('Main Street library');

    expect((await edit(requester, id, {})).statusCode).toBe(400);
    const unkeyed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/commands/edit`,
      headers: requester.headers,
      payload: { summary: 'No key' },
    });
    expect(unkeyed.statusCode).toBe(400);
  });
});

describe('ride destination (R8.7)', () => {
  it('is accepted for TRANSPORTATION and refused for other categories', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');

    const ride = await submit(requester, RIDE);
    expect(ride.response.statusCode).toBe(201);
    const refused = await submit(requester, { ...FOOD, destination: 'Somewhere' });
    expect(refused.response.statusCode).toBe(422);

    const food = await submit(requester, FOOD);
    expect((await edit(requester, food.id, { destination: 'Somewhere' })).statusCode).toBe(422);

    const edited = await edit(requester, ride.id, { destination: 'VA hospital' });
    expect(edited.json().destination).toBe('VA hospital');
    const cleared = await edit(requester, ride.id, { destination: null });
    expect(cleared.json().destination).toBeNull();
  });

  it('shows to the requester and the accepter, and never in the open list', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const helper = await person(tenantId, 'helper');
    const { id } = await submit(requester, RIDE);

    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open',
      headers: helper.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain(id);
    expect(listed.body).not.toContain('destination');
    expect(listed.body).not.toContain('County clinic');

    expect((await accept(helper, id)).statusCode).toBe(200);
    expect((await detail(requester, id)).json().destination).toBe('County clinic, 4th floor');
    expect((await detail(helper, id)).json().destination).toBe('County clinic, 4th floor');
  });
});

describe('adding a need to a case (R8.3)', () => {
  it('is refused for a helper on the case and still works for the owner', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const helper = await person(tenantId, 'helper');
    const { id, caseId } = await submit(requester, FOOD);
    expect((await accept(helper, id)).statusCode).toBe(200);

    const asHelper = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/service-requests`,
      headers: keyed(helper),
      payload: { category: 'FOOD' },
    });
    expect(asHelper.statusCode).toBe(403);
    expect(asHelper.json().error.code).toBe('FORBIDDEN');

    const asOwner = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/service-requests`,
      headers: keyed(requester),
      payload: { category: 'FOOD' },
    });
    expect(asOwner.statusCode).toBe(201);
  });
});
