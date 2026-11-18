/**
 * A case's holder standing ends with its cycle (requires PostgreSQL).
 *
 * V1_PROJECT_PLAN.md §2.1 and the 2026-11-05 decision that a helper holds one Service
 * Request. SUAS-specs CASES.md §4 and §4.2 (CLOSE ends the cycle; REOPEN starts a new one).
 * - After CLOSE, a former holder has no standing on the case or its sub-resources.
 * - After REOPEN and a new accept by another helper, a former holder is refused the case
 *   commands for a cycle they never accepted.
 * - R11.1 (CASES.md §4.3, SUAS-specs #85): standing follows the current accept record, so
 *   a RELEASE of the only request held ends it too.
 */

import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import {
  executeCaseCommand,
  executeCaseCommandInTx,
  holdsRequestInCase,
  recordContactInTx,
} from '../../src/coordination/index.js';
import { deployQrf } from '../../src/ui/commands.js';
import { appPool, createPerson, keyed } from '../helpers/actors.js';
import { testDatabaseUrl, validEnv } from '../helpers/env.js';

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

/** A signed-in person in Santa Clara; an admin also gets an MFA-elevated session (ADMIN.md §2). */
const person = (tenantId: string, label: string, verified = false, admin = false) =>
  createPerson(app, { tenantId, label, county: 'SANTA_CLARA', verified, admin });

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

/** Every case-level write a holder has (R11.1): the case commands, the contact log and resolve. */
const holderWrites = (caseId: string): [string, Record<string, unknown>][] => [
  [`/cases/${caseId}/commands/activate`, {}],
  [`/cases/${caseId}/commands/move-to-followup`, { reason: 'check back next week' }],
  [`/cases/${caseId}/commands/resume-active`, {}],
  [`/cases/${caseId}/commands/escalate`, { reason: 'needs more help' }],
  [`/cases/${caseId}/commands/close`, {}],
  [`/cases/${caseId}/commands/log-contact-attempt`, { channel: 'PHONE' }],
  [`/cases/${caseId}/commands/complete-contact`, { channel: 'PHONE', outcome: 'REACHED' }],
  [
    `/cases/${caseId}/commands/resolve`,
    { requested: {}, occurred: {}, fulfilled: {}, unresolved: {} },
  ],
];

/** Refused every holder write with the very answer a case that does not exist gets. */
async function expectNoStanding(who: Person, caseId: string) {
  const unknown = holderWrites(randomUUID());
  for (const [index, [url, payload]] of holderWrites(caseId).entries()) {
    const refused = await post(who, url, payload);
    const [missingUrl, missingPayload] = unknown[index]!;
    const missing = await post(who, missingUrl, missingPayload);
    expect(refused.statusCode, url).toBe(404);
    expect(refused.json(), url).toEqual(missing.json());
  }
}

describe('a requester is not a holder', () => {
  it('refuses the requester the holder-only resolve and close with 403', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const { caseId, requestId } = await submitRequest(requester);
    expect((await accept(helper, requestId)).statusCode).toBe(200);

    for (const [url, payload] of holderWrites(caseId).filter(([path]) =>
      /\/commands\/(resolve|close)$/.test(path),
    )) {
      const refused = await post(requester, url, payload);
      expect(refused.statusCode, url).toBe(403);
      expect(refused.json().error.code, url).toBe('FORBIDDEN');
    }
  });

  it('refuses the requester the contact log, to read or write, with 403', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const { caseId, requestId } = await submitRequest(requester);
    expect((await accept(helper, requestId)).statusCode).toBe(200);

    const read = await get(requester, `/cases/${caseId}/contact-attempts`);
    expect(read.statusCode).toBe(403);
    expect(read.json().error.code).toBe('FORBIDDEN');
    for (const [url, payload] of holderWrites(caseId).filter(([path]) => /contact/.test(path))) {
      const refused = await post(requester, url, payload);
      expect(refused.statusCode, url).toBe(403);
      expect(refused.json().error.code, url).toBe('FORBIDDEN');
    }
  });
});

describe('a person outside the case', () => {
  it('gets the same 404 for its settlements as for a case that does not exist', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const outsider = await person(tenantId, 'outsider');
    const { caseId, requestId } = await submitRequest(requester);
    expect((await accept(helper, requestId)).statusCode).toBe(200);
    await finishAndClose(requester, helper, caseId, requestId, { close: false });
    const [settlement] = (await get(requester, `/cases/${caseId}/settlements`)).json()
      .settlements as { settlement_id: string }[];
    const settlementId = settlement!.settlement_id;
    // The helper still reads it, so the outsider's 404 below comes from their standing.
    expect((await get(helper, `/cases/${caseId}/settlements/${settlementId}`)).statusCode).toBe(
      200,
    );

    const missingCase = randomUUID();
    for (const [url, missingUrl] of [
      [`/cases/${caseId}/settlements`, `/cases/${missingCase}/settlements`],
      [
        `/cases/${caseId}/settlements/${settlementId}`,
        `/cases/${missingCase}/settlements/${settlementId}`,
      ],
    ] as const) {
      const hidden = await get(outsider, url);
      expect(hidden.statusCode, url).toBe(404);
      expect(hidden.json(), url).toEqual((await get(outsider, missingUrl)).json());
    }
  });
});

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
    await expectNoStanding(helper, caseId);
    // The same cycle rule covers the request, its commands, and its chat. Case
    // sub-resources alone do not. The requester still reads their own closed request.
    expect((await get(helper, `/service-requests/${requestId}`)).statusCode).toBe(404);
    expect((await post(helper, `/service-requests/${requestId}/commands/START`)).statusCode).toBe(
      404,
    );
    expect((await get(helper, `/service-requests/${requestId}/chat/messages`)).statusCode).toBe(
      404,
    );
    const helperThreads = await get(helper, '/chat/threads');
    expect(
      (helperThreads.json().threads as { service_request_id: string }[]).map(
        (thread) => thread.service_request_id,
      ),
    ).not.toContain(requestId);
    expect((await get(requester, `/cases/${caseId}`)).statusCode).toBe(200);
    expect((await get(requester, `/service-requests/${requestId}`)).statusCode).toBe(200);
    const requesterThreads = await get(requester, '/chat/threads');
    expect(
      (requesterThreads.json().threads as { service_request_id: string }[]).map(
        (thread) => thread.service_request_id,
      ),
    ).toContain(requestId);
  });

  it('refuses a previous-cycle holder the case commands after REOPEN and a new accept', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const former = await person(tenantId, 'former');
    const next = await person(tenantId, 'next');
    const first = await submitRequest(requester);
    expect((await accept(former, first.requestId)).statusCode).toBe(200);
    await finishAndClose(requester, former, first.caseId, first.requestId);

    await executeCaseCommand(appPool(app), {
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
    // A previous-cycle accept does not keep the old request or its chat.
    expect((await get(former, `/service-requests/${first.requestId}`)).statusCode).toBe(404);
    expect(
      (await get(former, `/service-requests/${first.requestId}/chat/messages`)).statusCode,
    ).toBe(404);
    expect((await get(next, `/service-requests/${second.requestId}`)).statusCode).toBe(200);

    // The helper who accepted in this cycle can.
    expect((await post(next, `/cases/${first.caseId}/commands/activate`)).statusCode).toBe(200);
  });
  it('refuses a helper who released their only request, and lets the next holder act (R11.1)', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const released = await person(tenantId, 'released');
    const next = await person(tenantId, 'next');
    const { caseId, requestId } = await submitRequest(requester);
    expect((await accept(released, requestId)).statusCode).toBe(200);
    // ACTIVE, so each command below is one a holder could run.
    expect((await post(released, `/cases/${caseId}/commands/activate`)).statusCode).toBe(200);
    const handedBack = await post(released, `/service-requests/${requestId}/commands/RELEASE`, {
      reason: 'cannot make it',
    });
    expect(handedBack.statusCode).toBe(200);

    await expectNoStanding(released, caseId);
    expect((await get(released, `/cases/${caseId}`)).statusCode).toBe(404);

    // Standing is the accept record at the time of the command: the next accepter has it.
    expect((await accept(next, requestId)).statusCode).toBe(200);
    for (const [command, payload] of [
      ['escalate', { reason: 'needs more help' }],
      ['move-to-followup', { reason: 'check back next week' }],
      ['resume-active', {}],
    ] as const) {
      const ran = await post(next, `/cases/${caseId}/commands/${command}`, payload);
      expect(ran.statusCode, command).toBe(200);
    }
    // Holding a request gives no SUAS-admin command.
    for (const [command, payload] of [
      ['triage', {}],
      ['reopen', { reason: 'recurrence' }],
    ] as const) {
      const refused = await post(next, `/cases/${caseId}/commands/${command}`, payload);
      expect(refused.statusCode, command).toBe(403);
      expect(refused.json().error.code, command).toBe('FORBIDDEN');
    }
  });

  it('keeps the previous cycle settlement and contact log from the next-cycle helper', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const former = await person(tenantId, 'former');
    const next = await person(tenantId, 'next');
    const first = await submitRequest(requester);
    const caseId = first.caseId;
    expect((await accept(former, first.requestId)).statusCode).toBe(200);
    const logged = await post(former, `/cases/${caseId}/commands/log-contact-attempt`, {
      channel: 'PHONE',
    });
    expect(logged.statusCode).toBe(201);
    await finishAndClose(requester, former, caseId, first.requestId);
    const [cycleOne] = (await get(requester, `/cases/${caseId}/settlements`)).json()
      .settlements as { settlement_id: string }[];

    await executeCaseCommand(appPool(app), {
      tenantId,
      caseId,
      command: 'REOPEN',
      actorId: 'staff',
      actorType: 'SUAS_ADMIN',
      reason: 'new need on the same case',
    });
    const second = await submitRequest(requester);
    expect((await accept(next, second.requestId)).statusCode).toBe(200);
    expect(
      (await post(next, `/cases/${caseId}/commands/log-contact-attempt`, { channel: 'SMS' }))
        .statusCode,
    ).toBe(201);

    // CASES.md §4.3 (R11.1): the next helper's standing is this cycle's accept only.
    const settlements = await get(next, `/cases/${caseId}/settlements`);
    expect(settlements.statusCode).toBe(200);
    expect.soft(settlements.json().settlements).toEqual([]);
    expect
      .soft((await get(next, `/cases/${caseId}/settlements/${cycleOne!.settlement_id}`)).statusCode)
      .toBe(404);
    const attempts = (await get(next, `/cases/${caseId}/contact-attempts`)).json()
      .contact_attempts as { logged_by_user_id: string; channel: string }[];
    expect
      .soft(attempts.map((attempt) => [attempt.logged_by_user_id, attempt.channel]))
      .toEqual([[next.userId, 'SMS']]);

    // Resolving this cycle gives the helper this cycle's settlement, and only that one.
    await finishAndClose(requester, next, caseId, second.requestId, { close: false });
    const current = (await get(next, `/cases/${caseId}/settlements`)).json().settlements as {
      resolution_cycle: number;
      accepted_by_user_id: string;
    }[];
    expect(current.map((s) => [s.resolution_cycle, s.accepted_by_user_id])).toEqual([
      [2, next.userId],
    ]);
    // The requester still reads every cycle of their own case.
    const own = (await get(requester, `/cases/${caseId}/settlements`)).json().settlements as {
      resolution_cycle: number;
    }[];
    expect(own.map((s) => s.resolution_cycle)).toEqual([1, 2]);
    expect(
      (await get(requester, `/cases/${caseId}/settlements/${cycleOne!.settlement_id}`)).statusCode,
    ).toBe(200);
  });

  it('shows a helper of both cycles only the RESOLVED case settlement, though CLOSE keeps the pointer', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const first = await submitRequest(requester);
    const caseId = first.caseId;
    // The pointer is a cache that CLOSE and REOPEN leave set (DATA_MODEL.md §6/§8), so the
    // helper read keys on status RESOLVED, which only resolve writes, with the pointer.
    const stored = async () =>
      (
        await appPool(app).query<{ status: string; current_settlement_id: string | null }>(
          'SELECT status, current_settlement_id FROM support_cases WHERE case_id = $1',
          [caseId],
        )
      ).rows[0];
    const helperSettlementIds = async () =>
      (
        (await get(helper, `/cases/${caseId}/settlements`)).json().settlements as {
          settlement_id: string;
        }[]
      ).map((settlement) => settlement.settlement_id);

    expect((await accept(helper, first.requestId)).statusCode).toBe(200);
    await finishAndClose(requester, helper, caseId, first.requestId, { close: false });
    const cycleOne = (await stored())!.current_settlement_id!;
    expect(await stored()).toEqual({ status: 'RESOLVED', current_settlement_id: cycleOne });
    expect(await helperSettlementIds()).toEqual([cycleOne]);

    expect((await post(helper, `/cases/${caseId}/commands/close`)).statusCode).toBe(200);
    expect(await stored()).toEqual({ status: 'CLOSED', current_settlement_id: cycleOne });
    // CLOSE ends the helper's standing, so a CLOSED case shows them no settlement at all.
    expect((await get(helper, `/cases/${caseId}/settlements`)).statusCode).toBe(404);
    expect((await get(helper, `/cases/${caseId}/settlements/${cycleOne}`)).statusCode).toBe(404);
    await executeCaseCommand(appPool(app), {
      tenantId,
      caseId,
      command: 'REOPEN',
      actorId: 'staff',
      actorType: 'SUAS_ADMIN',
      reason: 'new need on the same case',
    });
    expect(await stored()).toEqual({ status: 'OPEN', current_settlement_id: cycleOne });

    // The same helper accepts in the new cycle: the stale pointer gives them nothing.
    const second = await submitRequest(requester);
    expect((await accept(helper, second.requestId)).statusCode).toBe(200);
    expect(await helperSettlementIds()).toEqual([]);
    expect((await get(helper, `/cases/${caseId}/settlements/${cycleOne}`)).statusCode).toBe(404);

    await finishAndClose(requester, helper, caseId, second.requestId, { close: false });
    const cycleTwo = (await stored())!.current_settlement_id!;
    expect(cycleTwo).not.toBe(cycleOne);
    expect(await stored()).toEqual({ status: 'RESOLVED', current_settlement_id: cycleTwo });
    expect(await helperSettlementIds()).toEqual([cycleTwo]);
    expect((await get(helper, `/cases/${caseId}/settlements/${cycleTwo}`)).statusCode).toBe(200);
    expect((await get(helper, `/cases/${caseId}/settlements/${cycleOne}`)).statusCode).toBe(404);
  });

  it("answers 404 for another case's settlement id, to the requester and the helper", async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const helper = await person(tenantId, 'helper');
    const first = await submitRequest(requester);
    expect((await accept(helper, first.requestId)).statusCode).toBe(200);
    await finishAndClose(requester, helper, first.caseId, first.requestId, { close: false });
    const [settlement] = (await get(requester, `/cases/${first.caseId}/settlements`)).json()
      .settlements as { settlement_id: string }[];
    const ownUrl = `/cases/${first.caseId}/settlements/${settlement!.settlement_id}`;

    // A RESOLVED case is not reused, so the next request opens a second case for both.
    const second = await submitRequest(requester);
    expect(second.caseId).not.toBe(first.caseId);
    expect((await accept(helper, second.requestId)).statusCode).toBe(200);
    const crossUrl = `/cases/${second.caseId}/settlements/${settlement!.settlement_id}`;

    for (const who of [requester, helper]) {
      expect((await get(who, ownUrl)).statusCode).toBe(200);
      expect((await get(who, crossUrl)).statusCode).toBe(404);
    }
  });
});

describe('holdsRequestInCase, the standing re-check a contact write runs under the case lock', () => {
  it('holds for an accept of the current cycle only', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const otherRequester = await person(tenantId, 'other-requester', true);
    const helper = await person(tenantId, 'helper');
    const holds = (caseId: string) =>
      holdsRequestInCase(appPool(app), tenantId, caseId, helper.userId);

    const first = await submitRequest(requester);
    const otherCase = (await submitRequest(otherRequester)).caseId;
    expect(await holds(first.caseId)).toBe(false);
    expect((await accept(helper, first.requestId)).statusCode).toBe(200);
    expect(await holds(first.caseId)).toBe(true);
    expect(await holds(otherCase)).toBe(false);

    await finishAndClose(requester, helper, first.caseId, first.requestId);
    expect(await holds(first.caseId)).toBe(false);
    await executeCaseCommand(appPool(app), {
      tenantId,
      caseId: first.caseId,
      command: 'REOPEN',
      actorId: 'staff',
      actorType: 'SUAS_ADMIN',
      reason: 'new need on the same case',
    });
    // Reopened, the case's only accept by this helper is from the previous cycle.
    expect(await holds(first.caseId)).toBe(false);

    const second = await submitRequest(requester);
    expect((await accept(helper, second.requestId)).statusCode).toBe(200);
    expect(await holds(first.caseId)).toBe(true);
    const released = await post(helper, `/service-requests/${second.requestId}/commands/RELEASE`, {
      reason: 'cannot make it',
    });
    expect(released.statusCode).toBe(200);
    expect(await holds(first.caseId)).toBe(false);
  });
});

describe('a close racing a helper write files it only in the cycle whose standing it passed', () => {
  /** Wait until `count` sessions wait on a row lock, or until `pending` settles first. */
  async function lockWaitersOrSettled(count: number, pending: Promise<unknown>) {
    let settled = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let tries = 0; tries < 300 && !settled; tries += 1) {
      const waiting = await appPool(app).query<{ n: string }>(
        `SELECT count(*) AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'`,
      );
      if (Number(waiting.rows[0]!.n) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** An ACTIVE case whose one request `former` accepted and finished, ready to resolve. */
  async function readyToResolve() {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester', true);
    const former = await person(tenantId, 'former');
    const next = await person(tenantId, 'next');
    const { caseId, requestId } = await submitRequest(requester);
    expect((await accept(former, requestId)).statusCode).toBe(200);
    for (const [who, url] of [
      [former, `/cases/${caseId}/commands/activate`],
      [former, `/service-requests/${requestId}/commands/START`],
      [former, `/service-requests/${requestId}/commands/FULFILL`],
      [requester, `/service-requests/${requestId}/commands/CONFIRM`],
      [former, `/service-requests/${requestId}/commands/CLOSE`],
    ] as const) {
      expect((await post(who, url)).statusCode, url).toBe(200);
    }
    return { tenantId, requester, former, next, caseId };
  }

  const settlementContent = { requested: {}, occurred: {}, fulfilled: {}, unresolved: {} };

  /** REOPEN, then `next` accepts a new request: what does the next-cycle helper read? */
  async function nextCycleReads(world: Awaited<ReturnType<typeof readyToResolve>>) {
    const { tenantId, requester, next, caseId } = world;
    await executeCaseCommand(appPool(app), {
      tenantId,
      caseId,
      command: 'REOPEN',
      actorId: 'staff',
      actorType: 'SUAS_ADMIN',
      reason: 'new need on the same case',
    });
    const second = await submitRequest(requester);
    expect((await accept(next, second.requestId)).statusCode).toBe(200);
    return {
      settlements: (await get(next, `/cases/${caseId}/settlements`)).json()
        .settlements as unknown[],
      attempts: (await get(next, `/cases/${caseId}/contact-attempts`)).json()
        .contact_attempts as unknown[],
    };
  }

  function closeIn(tx: PoolClient, world: { tenantId: string; caseId: string; former: Person }) {
    return executeCaseCommandInTx(tx, {
      tenantId: world.tenantId,
      caseId: world.caseId,
      command: 'CLOSE',
      actorId: world.former.userId,
      actorType: 'USER',
    });
  }

  it('refuses a contact write that waited on an uncommitted CLOSE', async () => {
    const world = await readyToResolve();
    expect(
      (await post(world.former, `/cases/${world.caseId}/commands/resolve`, settlementContent))
        .statusCode,
    ).toBe(200);
    const closing = await appPool(app).connect();
    try {
      await closing.query('BEGIN');
      await closeIn(closing, world);
      const write = post(world.former, `/cases/${world.caseId}/commands/log-contact-attempt`, {
        channel: 'PHONE',
      });
      await lockWaitersOrSettled(1, write);
      await closing.query('COMMIT');
      expect((await write).statusCode).not.toBe(201);
    } finally {
      closing.release();
    }
    expect((await nextCycleReads(world)).attempts).toEqual([]);
  });

  it('refuses a contact write that waited on CLOSE even with a REOPEN queued behind it', async () => {
    const world = await readyToResolve();
    expect(
      (await post(world.former, `/cases/${world.caseId}/commands/resolve`, settlementContent))
        .statusCode,
    ).toBe(200);
    const closing = await appPool(app).connect();
    try {
      await closing.query('BEGIN');
      await closeIn(closing, world);
      const write = post(world.former, `/cases/${world.caseId}/commands/log-contact-attempt`, {
        channel: 'PHONE',
      });
      await lockWaitersOrSettled(1, write);
      // The admin REOPEN queues on the case row behind the write, so the write is granted
      // the row first, the moment CLOSE commits, and re-checks a CLOSED case.
      const reopened = executeCaseCommand(appPool(app), {
        tenantId: world.tenantId,
        caseId: world.caseId,
        command: 'REOPEN',
        actorId: 'staff',
        actorType: 'SUAS_ADMIN',
        reason: 'new need on the same case',
      });
      await lockWaitersOrSettled(2, reopened);
      await closing.query('COMMIT');
      const refused = await write;
      expect([refused.statusCode, refused.json().error.code]).toEqual([403, 'FORBIDDEN']);
      expect((await reopened).status).toBe('OPEN');
    } finally {
      closing.release();
    }
    // The same helper accepts in the new cycle; the refused write is not in it.
    const second = await submitRequest(world.requester);
    expect((await accept(world.former, second.requestId)).statusCode).toBe(200);
    expect(
      (await get(world.former, `/cases/${world.caseId}/contact-attempts`)).json().contact_attempts,
    ).toEqual([]);
  });

  it("files a write in flight across CLOSE, REOPEN and its helper's new accept in the new cycle", async () => {
    const world = await readyToResolve();
    expect(
      (await post(world.former, `/cases/${world.caseId}/commands/resolve`, settlementContent))
        .statusCode,
    ).toBe(200);
    const contact = await appPool(app).connect();
    let written: Awaited<ReturnType<typeof recordContactInTx>>;
    try {
      // The write's transaction begins in the old cycle, as a slow request's would.
      await contact.query('BEGIN');
      await contact.query('SELECT now()');
      expect((await post(world.former, `/cases/${world.caseId}/commands/close`)).statusCode).toBe(
        200,
      );
      await executeCaseCommand(appPool(app), {
        tenantId: world.tenantId,
        caseId: world.caseId,
        command: 'REOPEN',
        actorId: 'staff',
        actorType: 'SUAS_ADMIN',
        reason: 'new need on the same case',
      });
      const second = await submitRequest(world.requester);
      expect((await accept(world.former, second.requestId)).statusCode).toBe(200);
      // CASES.md §4.3: standing is the accept record when the command runs, and the helper
      // now holds this cycle's request, so the write stands and belongs to this cycle.
      written = await recordContactInTx(contact, {
        tenantId: world.tenantId,
        caseId: world.caseId,
        loggedByUserId: world.former.userId,
        command: 'log-contact-attempt',
        channel: 'PHONE',
        outcome: 'PENDING',
      });
      await contact.query('COMMIT');
    } finally {
      contact.release();
    }
    const attempts = (await get(world.former, `/cases/${world.caseId}/contact-attempts`)).json()
      .contact_attempts as { contact_attempt_id: string }[];
    expect(attempts.map((attempt) => attempt.contact_attempt_id)).toEqual([
      written.contactAttempt.contactAttemptId,
    ]);
  });

  it('keeps a contact write that held the case before a CLOSE begun earlier in the old cycle', async () => {
    const world = await readyToResolve();
    expect(
      (await post(world.former, `/cases/${world.caseId}/commands/resolve`, settlementContent))
        .statusCode,
    ).toBe(200);
    const closing = await appPool(app).connect();
    const contact = await appPool(app).connect();
    try {
      // CLOSE's transaction starts first, so its now() predates the contact write.
      await closing.query('BEGIN');
      await closing.query('SELECT now()');
      await contact.query('BEGIN');
      await recordContactInTx(contact, {
        tenantId: world.tenantId,
        caseId: world.caseId,
        loggedByUserId: world.former.userId,
        command: 'log-contact-attempt',
        channel: 'PHONE',
        outcome: 'PENDING',
      });
      const closed = closeIn(closing, world);
      await lockWaitersOrSettled(1, closed);
      await contact.query('COMMIT');
      await closed;
      await closing.query('COMMIT');
    } finally {
      contact.release();
      closing.release();
    }
    expect((await nextCycleReads(world)).attempts).toEqual([]);
  });

  it('keeps a settlement committed while an earlier-begun CLOSE waited out of the next cycle', async () => {
    const world = await readyToResolve();
    const blocker = await appPool(app).connect();
    const closing = await appPool(app).connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT 1 FROM support_cases WHERE case_id = $1 FOR UPDATE', [
        world.caseId,
      ]);
      await closing.query('BEGIN');
      await closing.query('SELECT now()');
      // The resolve queues on the case row first, then the CLOSE behind it.
      const resolved = post(
        world.former,
        `/cases/${world.caseId}/commands/resolve`,
        settlementContent,
      );
      await lockWaitersOrSettled(1, resolved);
      const closed = closeIn(closing, world);
      await lockWaitersOrSettled(2, closed);
      await blocker.query('COMMIT');
      expect((await resolved).statusCode).toBe(200);
      await closed;
      await closing.query('COMMIT');
    } finally {
      blocker.release();
      closing.release();
    }
    expect((await nextCycleReads(world)).settlements).toEqual([]);
  });

  it('lets two contact writes share the case row while a CLOSE waits them out, without deadlock', async () => {
    const world = await readyToResolve();
    expect(
      (await post(world.former, `/cases/${world.caseId}/commands/resolve`, settlementContent))
        .statusCode,
    ).toBe(200);
    const writers = [await appPool(app).connect(), await appPool(app).connect()];
    const closing = await appPool(app).connect();
    try {
      // A wait that never ends fails here in 5 s instead of hanging; a lock cycle fails as 40P01.
      for (const client of [...writers, closing]) {
        await client.query('BEGIN');
        await client.query(`SET LOCAL lock_timeout = '5s'`);
      }
      // Both hold FOR SHARE on the case row at once: neither waits on, or upgrades past, the other.
      for (const client of writers) {
        await recordContactInTx(client, {
          tenantId: world.tenantId,
          caseId: world.caseId,
          loggedByUserId: world.former.userId,
          command: 'log-contact-attempt',
          channel: 'PHONE',
          outcome: 'PENDING',
        });
      }
      const closed = closeIn(closing, world);
      await lockWaitersOrSettled(1, closed);
      for (const client of writers) await client.query('COMMIT');
      expect((await closed).status).toBe('CLOSED');
      await closing.query('COMMIT');
    } finally {
      for (const client of [...writers, closing]) client.release();
    }
    // Both writes held the case before the CLOSE, so they stay in the closed cycle.
    expect((await nextCycleReads(world)).attempts).toEqual([]);
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
    await appPool(app).query(
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
    const deployed = await deployQrf(appPool(app), {
      tenantId,
      veteranUserId: requester.userId,
      correlationId: randomUUID(),
    });
    expect(deployed.serviceRequestId).toBeDefined();
    const cases = await appPool(app).query(
      `SELECT status FROM support_cases WHERE veteran_user_id = $1 ORDER BY created_at`,
      [requester.userId],
    );
    expect(cases.rows.map((row: { status: string }) => row.status)).toEqual(['RESOLVED', 'OPEN']);
  });
});
