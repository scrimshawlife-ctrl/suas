/**
 * Released CASES.md §4 commands over /api/v0 (beyond accept/resolve), for the person
 * who accepted a case and for SUAS System Administrators (V1_PROJECT_PLAN.md §2.1).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { findCurrentCase } from '../../src/coordination/index.js';
import { createPerson, openRedCase } from '../helpers/actors.js';
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

/**
 * A signed-in person in the launch county. `admin` adds the SUAS System Administrator grant
 * and, unless `elevate` is false, an MFA-elevated session.
 */
function person(
  tenantId: string,
  label: string,
  options: { admin?: boolean; elevate?: boolean } = {},
) {
  const elevate = options.admin === true && options.elevate !== false;
  return createPerson(app, {
    tenantId,
    label,
    county: 'SANTA_CLARA',
    admin: options.admin,
    elevate,
  });
}

/** The requester submits a request on their case, which puts it on the open list. */
async function submitRequest(headers: Record<string, string>, caseId: string): Promise<string> {
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${caseId}/service-requests`,
    headers: { ...headers, 'idempotency-key': `sr-${randomUUID()}` },
    payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
  });
  expect(created.statusCode).toBe(201);
  const id: string = created.json().service_request_id;
  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/commands/SUBMIT`,
    headers: { ...headers, 'idempotency-key': `submit-${randomUUID()}` },
    payload: {},
  });
  expect(submitted.statusCode).toBe(200);
  return id;
}

function settlementPayload(accepterId: string) {
  return {
    requested: { service_requests: [] },
    occurred: { contact_attempts: 1 },
    fulfilled: { fulfillments: [] },
    unresolved: { notes: 'none' },
    authored_by: accepterId,
    accepted_by_user_id: accepterId,
  };
}

describe('CASE_COMMANDS over /api/v0', () => {
  it('runs claim → activate → escalate → move-to-followup → resume → resolve → close → reopen', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const responder = await person(tenantId, 'accepter');
    const admin = await person(tenantId, 'staff', { admin: true });
    const caseId = supportCase.caseId;
    const requestId = await submitRequest(veteranHeaders, caseId);

    const claimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/accept`,
      headers: responder.headers,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().case_status).toBe('ASSIGNED');

    const activated = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/activate`,
      headers: { ...responder.headers, 'idempotency-key': `act-${randomUUID()}` },
      payload: {},
    });
    expect(activated.statusCode).toBe(200);
    expect(activated.json()).toMatchObject({ status: 'ACTIVE', replayed: false });

    const escalateKey = `esc-${randomUUID()}`;
    const escalated = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/escalate`,
      headers: { ...responder.headers, 'idempotency-key': escalateKey },
      payload: { reason: 'needs supervisor eyes' },
    });
    expect(escalated.statusCode).toBe(200);
    expect(escalated.json().status).toBe('ACTIVE');

    const escalateReplay = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/escalate`,
      headers: { ...responder.headers, 'idempotency-key': escalateKey },
      payload: { reason: 'needs supervisor eyes' },
    });
    expect(escalateReplay.statusCode).toBe(200);
    expect(escalateReplay.json().replayed).toBe(true);

    const followup = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/move-to-followup`,
      headers: { ...responder.headers, 'idempotency-key': `fu-${randomUUID()}` },
      payload: { reason: 'waiting on resource callback' },
    });
    expect(followup.statusCode).toBe(200);
    expect(followup.json().status).toBe('FOLLOWUP');

    const resumed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/resume-active`,
      headers: { ...responder.headers, 'idempotency-key': `resume-${randomUUID()}` },
      payload: {},
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe('ACTIVE');

    // A case cannot resolve while a request is still open (CASES.md §4, §7).
    const cancelled = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/commands/CANCEL`,
      headers: { ...veteranHeaders, 'idempotency-key': `cancel-${randomUUID()}` },
      payload: { reason: 'need met another way' },
    });
    expect(cancelled.statusCode).toBe(200);

    const resolved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/resolve`,
      headers: { ...responder.headers, 'idempotency-key': `resolve-${randomUUID()}` },
      payload: settlementPayload(responder.userId),
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe('RESOLVED');
    // The resolve answer never carries the level, whoever resolves.
    expect(resolved.json().priority_signal_level).toBeNull();

    const closed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/close`,
      headers: { ...responder.headers, 'idempotency-key': `close-${randomUUID()}` },
      payload: {},
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json().status).toBe('CLOSED');

    const reopened = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/reopen`,
      headers: { ...admin.headers, 'idempotency-key': `reopen-${randomUUID()}` },
      payload: { reason: 'veteran reported recurrence' },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json().status).toBe('OPEN');
  });

  it('lets only SUAS System Administrators triage, and keeps other people out of a case', async () => {
    const a = await openRedCase(app);
    const b = await openRedCase(app);
    const staffA = await person(a.tenantId, 'staff', { admin: true });
    const accepterA = await person(a.tenantId, 'accepter');
    const accepterB = await person(b.tenantId, 'accepter');
    const requestB = await submitRequest(b.headers, b.supportCase.caseId);

    const forbidden = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/commands/triage`,
      headers: { ...accepterA.headers, 'idempotency-key': `triage-${randomUUID()}` },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);

    const triaged = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${a.supportCase.caseId}/commands/triage`,
      headers: { ...staffA.headers, 'idempotency-key': `triage-${randomUUID()}` },
      payload: {},
    });
    expect(triaged.statusCode).toBe(200);
    expect(triaged.json().status).toBe('TRIAGED');

    const claimedB = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestB}/accept`,
      headers: accepterB.headers,
    });
    expect(claimedB.statusCode).toBe(200);

    const activateMissing = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/activate`,
      headers: accepterB.headers,
      payload: {},
    });
    expect(activateMissing.statusCode).toBe(400);

    // Someone who is neither the requester nor the accepter cannot tell the case exists.
    const foreign = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/activate`,
      headers: { ...accepterA.headers, 'idempotency-key': `xtenant-${randomUUID()}` },
      payload: {},
    });
    expect(foreign.statusCode).toBe(404);
  });
});

describe('ADMIN.md §2 / SECURITY.md §2 — admin case commands need MFA', () => {
  it('refuses triage, reopen and close from an unelevated SUAS admin with MFA_REQUIRED', async () => {
    const { pool, supportCase, tenantId } = await openRedCase(app);
    const unelevated = await person(tenantId, 'staff', { admin: true, elevate: false });

    for (const [kebab, payload] of [
      ['triage', {}],
      ['reopen', { reason: 'recurrence' }],
      ['close', {}],
    ] as const) {
      const response = await app.server.inject({
        method: 'POST',
        url: `/api/v0/cases/${supportCase.caseId}/commands/${kebab}`,
        headers: { ...unelevated.headers, 'idempotency-key': `${kebab}-${randomUUID()}` },
        payload,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('MFA_REQUIRED');
    }
    const after = await findCurrentCase(pool, tenantId, supportCase.veteranUserId);
    expect(after?.status).toBe(supportCase.status);
  });
});

describe('CASES.md §5 item 5 — accept replay over /api/v0', () => {
  it('returns the original assignment to the holder and 409 to anyone else', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const accepter = await person(tenantId, 'accepter');
    const other = await person(tenantId, 'accepter-b');
    const requestId = await submitRequest(veteranHeaders, supportCase.caseId);
    const url = `/api/v0/service-requests/${requestId}/accept`;

    const first = await app.server.inject({ method: 'POST', url, headers: accepter.headers });
    expect(first.statusCode).toBe(200);
    const replay = await app.server.inject({ method: 'POST', url, headers: accepter.headers });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().assignment_id).toBe(first.json().assignment_id);
    expect(replay.json().case_status).toBe(first.json().case_status);

    const loser = await app.server.inject({ method: 'POST', url, headers: other.headers });
    expect(loser.statusCode).toBe(409);
  });
});

describe('CASES.md §3 / SAFETY.md §3.3 — the priority level is not shown to helpers', () => {
  it('shows the priority level to the requester and a SUAS admin, and null to the accepter', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const accepter = await person(tenantId, 'accepter');
    const staff = await person(tenantId, 'staff', { admin: true });
    const url = `/api/v0/cases/${supportCase.caseId}`;
    const adminCommand = await app.server.inject({
      method: 'POST',
      url: `${url}/commands/triage`,
      headers: { ...staff.headers, 'idempotency-key': `triage-${randomUUID()}` },
      payload: {},
    });
    expect(adminCommand.json().priority_signal_level).toBe('RED');

    const requestId = await submitRequest(veteranHeaders, supportCase.caseId);
    const accepted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/accept`,
      headers: accepter.headers,
    });
    expect(accepted.statusCode).toBe(200);

    const owner = await app.server.inject({ method: 'GET', url, headers: veteranHeaders });
    expect(owner.json().priority_signal_level).toBe('RED');
    const peer = await app.server.inject({ method: 'GET', url, headers: accepter.headers });
    expect(peer.statusCode).toBe(200);
    expect(peer.json().priority_signal_level).toBeNull();

    const peerCommand = await app.server.inject({
      method: 'POST',
      url: `${url}/commands/escalate`,
      headers: { ...accepter.headers, 'idempotency-key': `peer-${randomUUID()}` },
      payload: { reason: 'needs more help' },
    });
    expect(peerCommand.statusCode).toBe(200);
    expect(peerCommand.json().priority_signal_level).toBeNull();
  });

  it('returns no priority field on any helper-facing request or chat route', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const helper = await person(tenantId, 'helper');
    const requestId = await submitRequest(veteranHeaders, supportCase.caseId);

    const get = (url: string) => app.server.inject({ method: 'GET', url, headers: helper.headers });
    const open = await get('/api/v0/service-requests?ownership=open');
    expect(open.statusCode).toBe(200);
    expect(open.body).toContain(requestId);
    expect(open.body).not.toMatch(/priority|"RED"/);

    const accepted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/accept`,
      headers: helper.headers,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.body).not.toMatch(/priority/);

    for (const url of [
      `/api/v0/service-requests/${requestId}`,
      '/api/v0/service-requests?ownership=mine',
      '/api/v0/chat/threads',
      `/api/v0/service-requests/${requestId}/chat/messages`,
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.body, url).not.toMatch(/priority|"RED"/);
    }
  });
});
