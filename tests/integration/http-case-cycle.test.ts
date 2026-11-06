/**
 * A case's holder standing ends with its cycle (requires PostgreSQL).
 *
 * V1_PROJECT_PLAN.md §2.1 and the 2026-11-05 decision that a helper holds one Service
 * Request. SUAS-specs CASES.md §4 and §4.2 (CLOSE ends the cycle; REOPEN starts a new one).
 * - After CLOSE, a former holder has no standing on the case or its sub-resources.
 * - After REOPEN and a new accept by another helper, a former holder is refused the case
 *   commands for a cycle they never accepted.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { executeCaseCommand } from '../../src/coordination/index.js';
import { deployQrf } from '../../src/ui/commands.js';
import { createUser, grantSuasAdmin } from '../../src/identity/index.js';
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
  label: string,
  verified = false,
  admin = false,
): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  if (verified) await markVerifiedVeteran(pool(), tenantId, user.userId);
  if (admin) await grantSuasAdmin(pool(), user.userId, undefined);
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

function post(who: Person, url: string, payload: Record<string, unknown> = {}) {
  return app.server.inject({ method: 'POST', url: `/api/v0${url}`, headers: keyed(who), payload });
}

function get(who: Person, url: string) {
  return app.server.inject({ method: 'GET', url: `/api/v0${url}`, headers: who.headers });
}

/** Open the Veteran's case if needed and submit one FOOD request on it. */
async function submitRequest(requester: Person): Promise<{ caseId: string; requestId: string }> {
  const opened = await post(requester, '/cases');
  expect([200, 201]).toContain(opened.statusCode);
  const caseId: string = opened.json().case_id;
  const created = await post(requester, `/cases/${caseId}/service-requests`, {
    category: 'FOOD',
    details: { summary: 'Groceries', meeting_place: 'Main Street library' },
  });
  expect(created.statusCode).toBe(201);
  const requestId: string = created.json().service_request_id;
  expect((await post(requester, `/service-requests/${requestId}/commands/SUBMIT`)).statusCode).toBe(
    200,
  );
  return { caseId, requestId };
}

function accept(who: Person, requestId: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${requestId}/accept`,
    headers: who.headers,
  });
}

/** Take an accepted request to done and its case to CLOSED, the way the helper would. */
async function finishAndClose(
  requester: Person,
  helper: Person,
  caseId: string,
  requestId: string,
  options: { close?: boolean } = {},
) {
  const step = async (who: Person, url: string, payload: Record<string, unknown> = {}) =>
    expect((await post(who, url, payload)).statusCode).toBe(200);
  await step(helper, `/cases/${caseId}/commands/activate`);
  await step(helper, `/service-requests/${requestId}/commands/START`);
  await step(helper, `/service-requests/${requestId}/commands/FULFILL`);
  await step(requester, `/service-requests/${requestId}/commands/CONFIRM`);
  await step(helper, `/service-requests/${requestId}/commands/CLOSE`);
  await step(helper, `/cases/${caseId}/commands/resolve`, {
    requested: {},
    occurred: {},
    fulfilled: {},
    unresolved: {},
  });
  if (options.close !== false) await step(helper, `/cases/${caseId}/commands/close`);
}

const caseSubResources = (caseId: string) => [
  `/cases/${caseId}`,
  `/cases/${caseId}/settlements`,
  `/cases/${caseId}/contact-attempts`,
  `/cases/${caseId}/follow-ups`,
  `/cases/${caseId}/service-requests`,
];

describe('holder standing ends with the case cycle', () => {
  it('gives a former holder 404 on the case and its sub-resources after CLOSE', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const { caseId, requestId } = await submitRequest(requester);
    expect((await accept(helper, requestId)).statusCode).toBe(200);

    // While the case is live, the holder reads all of it.
    for (const url of caseSubResources(caseId)) {
      expect((await get(helper, url)).statusCode, url).toBe(200);
    }

    await finishAndClose(requester, helper, caseId, requestId);

    for (const url of caseSubResources(caseId)) {
      expect((await get(helper, url)).statusCode, url).toBe(404);
    }
    const logged = await post(helper, `/cases/${caseId}/commands/log-contact-attempt`, {
      channel: 'PHONE',
    });
    expect(logged.statusCode).toBe(404);
    // The requester still reads their own closed case.
    expect((await get(requester, `/cases/${caseId}`)).statusCode).toBe(200);
  });

  it('refuses a previous-cycle holder the case commands after REOPEN and a new accept', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const former = await person(tenantId, 'former');
    const next = await person(tenantId, 'next');
    const first = await submitRequest(requester);
    expect((await accept(former, first.requestId)).statusCode).toBe(200);
    await finishAndClose(requester, former, first.caseId, first.requestId);

    await executeCaseCommand(pool(), {
      tenantId,
      caseId: first.caseId,
      command: 'REOPEN',
      actorId: 'staff',
      actorType: 'SUAS_ADMIN',
      reason: 'new need on the same case',
    });
    // The reopened case is the Veteran's current one, so a new request joins it.
    const second = await submitRequest(requester);
    expect(second.caseId).toBe(first.caseId);
    expect((await accept(next, second.requestId)).statusCode).toBe(200);

    // The former holder holds only a previous-cycle request.
    for (const command of ['activate', 'escalate', 'move-to-followup']) {
      const refused = await post(former, `/cases/${first.caseId}/commands/${command}`, {
        reason: 'not mine',
      });
      expect(refused.statusCode, command).toBe(404);
    }
    const resolved = await post(former, `/cases/${first.caseId}/commands/resolve`, {
      requested: {},
      occurred: {},
      fulfilled: {},
      unresolved: {},
    });
    expect(resolved.statusCode).toBe(404);
    expect((await get(former, `/cases/${first.caseId}`)).statusCode).toBe(404);

    // The helper who accepted in this cycle can.
    expect((await post(next, `/cases/${first.caseId}/commands/activate`)).statusCode).toBe(200);
  });
});

describe('a new request after the case is resolved or closed', () => {
  it('opens a new case that reaches the open list, beside the intact RESOLVED one', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const former = await person(tenantId, 'former');
    const next = await person(tenantId, 'next');
    const first = await submitRequest(requester);
    expect((await accept(former, first.requestId)).statusCode).toBe(200);
    await finishAndClose(requester, former, first.caseId, first.requestId, { close: false });
    expect((await get(requester, `/cases/${first.caseId}`)).json().status).toBe('RESOLVED');

    const second = await submitRequest(requester);

    expect(second.caseId).not.toBe(first.caseId);
    // The new request is open to anyone else in the county, and the old one is not.
    const open = await get(next, '/service-requests?ownership=open');
    expect(
      (open.json().service_requests as { service_request_id: string }[]).map(
        (item) => item.service_request_id,
      ),
    ).toEqual([second.requestId]);
    expect((await accept(next, second.requestId)).statusCode).toBe(200);

    // The old case is untouched: still RESOLVED with its settlement, and still the former
    // holder's to read.
    expect((await get(requester, `/cases/${first.caseId}`)).json().status).toBe('RESOLVED');
    expect(
      (await get(requester, `/cases/${first.caseId}/settlements`)).json().settlements,
    ).toHaveLength(1);
    expect((await get(former, `/cases/${first.caseId}`)).statusCode).toBe(200);
    // The former holder has no standing on the new case; its new holder does.
    expect((await get(former, `/cases/${second.caseId}`)).statusCode).toBe(404);
    const refused = await post(former, `/cases/${second.caseId}/commands/log-contact-attempt`, {
      channel: 'PHONE',
    });
    expect(refused.statusCode).toBe(404);
    expect((await get(next, `/cases/${second.caseId}`)).statusCode).toBe(200);
    expect((await get(next, `/cases/${first.caseId}`)).statusCode).toBe(404);
  });

  it('also opens a new case after the old one is CLOSED', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const first = await submitRequest(requester);
    await accept(helper, first.requestId);
    await finishAndClose(requester, helper, first.caseId, first.requestId);

    const second = await submitRequest(requester);
    expect(second.caseId).not.toBe(first.caseId);
    expect((await get(requester, '/veterans/me')).json().open_case).toMatchObject({
      case_id: second.caseId,
    });
  });

  it('allows a direct create on a RESOLVED case and keeps that request off the open list', async () => {
    // Released DISPATCH.md §4 (pin 0.7.0): creation requires the parent Case to exist
    // and not be CLOSED. RESOLVED is not CLOSED, so this create is still allowed.
    // Proposal R6.14 records the result: the request is not acceptable. Refusing the
    // create, or attaching it to a new case, is not authorized until a spec change.
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const first = await submitRequest(requester);
    expect((await accept(helper, first.requestId)).statusCode).toBe(200);
    await finishAndClose(requester, helper, first.caseId, first.requestId, { close: false });
    expect((await get(requester, `/cases/${first.caseId}`)).json().status).toBe('RESOLVED');

    const created = await post(requester, `/cases/${first.caseId}/service-requests`, {
      category: 'FOOD',
      details: { summary: 'More groceries', meeting_place: 'Main Street library' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().case_id).toBe(first.caseId);
    const stranded: string = created.json().service_request_id;
    expect(
      (await post(requester, `/service-requests/${stranded}/commands/SUBMIT`)).statusCode,
    ).toBe(200);

    const open = await get(helper, '/service-requests?ownership=open');
    expect(open.statusCode).toBe(200);
    expect(
      (open.json().service_requests as { service_request_id: string }[]).map(
        (item) => item.service_request_id,
      ),
    ).not.toContain(stranded);
    const accepted = await accept(helper, stranded);
    expect(accepted.statusCode).toBe(404);
    expect(accepted.json().error.code).toBe('NOT_FOUND');

    expect((await post(helper, `/cases/${first.caseId}/commands/close`)).statusCode).toBe(200);
    const onClosed = await post(requester, `/cases/${first.caseId}/service-requests`, {
      category: 'FOOD',
      details: { summary: 'After close', meeting_place: 'Main Street library' },
    });
    expect(onClosed.statusCode).toBe(422);
    expect(onClosed.json().error.code).toBe('UNPROCESSABLE');
  });

  it('shows no open case while the Veteran only has a RESOLVED one', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const first = await submitRequest(requester);
    await accept(helper, first.requestId);
    await finishAndClose(requester, helper, first.caseId, first.requestId, { close: false });

    expect((await get(requester, '/veterans/me')).json().open_case).toBeNull();
  });

  it('refuses an admin REOPEN with 409 while the Veteran has a newer current case', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const admin = await person(tenantId, 'staff', false, true);
    const first = await submitRequest(requester);
    await accept(helper, first.requestId);
    await finishAndClose(requester, helper, first.caseId, first.requestId);
    const second = await submitRequest(requester);
    expect(second.caseId).not.toBe(first.caseId);

    const blocked = await post(admin, `/cases/${first.caseId}/commands/reopen`, {
      reason: 'recurrence',
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await get(requester, `/cases/${first.caseId}`)).json().status).toBe('CLOSED');

    // Once the newer case is finished and closed there is room to reopen the old one.
    await post(requester, `/service-requests/${second.requestId}/commands/CANCEL`, {
      reason: 'sorted out',
    });
    await pool().query(
      `UPDATE support_cases SET status = 'CLOSED', closed_at = now() WHERE case_id = $1`,
      [second.caseId],
    );
    expect(
      (await post(admin, `/cases/${first.caseId}/commands/reopen`, { reason: 'recurrence' }))
        .statusCode,
    ).toBe(200);
  });

  it('opens a new case from every way of asking: the form, an intake draft and the legacy Deploy', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const first = await submitRequest(requester);
    await accept(helper, first.requestId);
    await finishAndClose(requester, helper, first.caseId, first.requestId, { close: false });

    const form = await post(requester, '/service-requests', {
      category: 'FOOD',
      summary: 'Groceries',
      meeting_place: 'Main Street library',
    });
    expect(form.statusCode).toBe(201);
    expect(form.json().case_id).not.toBe(first.caseId);
    const formCase: string = form.json().case_id;
    // The form's case is now current, so the next ask joins it rather than opening a third.
    const second = await post(requester, '/service-requests', {
      category: 'PEER_SUPPORT',
      summary: 'Someone to talk to',
    });
    expect(second.json().case_id).toBe(formCase);

    // The legacy Deploy resolves the same current case.
    const deployed = await deployQrf(pool(), {
      tenantId,
      veteranUserId: requester.userId,
      correlationId: randomUUID(),
    });
    expect(deployed.serviceRequestId).toBeDefined();
    const cases = await pool().query(
      `SELECT status FROM support_cases WHERE veteran_user_id = $1 ORDER BY created_at`,
      [requester.userId],
    );
    expect(cases.rows.map((row: { status: string }) => row.status)).toEqual(['RESOLVED', 'OPEN']);
  });
});
