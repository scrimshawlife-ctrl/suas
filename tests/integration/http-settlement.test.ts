/**
 * Case resolve + Settlement HTTP surface.
 *
 * SUAS-specs API.md §7 / §9; SETTLEMENT.md §1–§6; CASES.md §4 RESOLVE.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { appPool, bearer, openRedCase } from '../helpers/actors.js';
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

/** A signed-in person in the launch county who can accept requests. */
async function accepterFor(tenantId: string) {
  const pool = appPool(app);
  const responder = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`acc-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    county: 'SANTA_CLARA',
  });
  return { responder, headers: await bearer(app, tenantId, responder.userId) };
}

function settlementPayload(responderId: string) {
  return {
    requested: { service_requests: [] },
    occurred: { contact_attempts: 1, assignments: 1 },
    fulfilled: { fulfillments: [] },
    unresolved: { notes: 'none' },
    authored_by: responderId,
    accepted_by_user_id: responderId,
  };
}

/**
 * The Veteran submits a request, the accepter accepts it and activates the case, and
 * the Veteran then withdraws the request: a case cannot resolve while a request is open.
 */
async function claimAndActivate(
  tenantId: string,
  caseId: string,
  veteranHeaders: Record<string, string>,
) {
  const { responder, headers } = await accepterFor(tenantId);
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${caseId}/service-requests`,
    headers: { ...veteranHeaders, 'idempotency-key': `sr-${randomUUID()}` },
    payload: { category: 'PEER_SUPPORT' },
  });
  const requestId = created.json().service_request_id as string;
  await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${requestId}/commands/SUBMIT`,
    headers: { ...veteranHeaders, 'idempotency-key': `submit-${randomUUID()}` },
    payload: {},
  });
  const claimed = await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${requestId}/accept`,
    headers,
  });
  expect(claimed.statusCode).toBe(200);
  const activated = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${caseId}/commands/activate`,
    headers: { ...headers, 'idempotency-key': `activate-${randomUUID()}` },
    payload: {},
  });
  expect(activated.statusCode).toBe(200);
  expect(activated.json().status).toBe('ACTIVE');
  await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${requestId}/commands/CANCEL`,
    headers: { ...veteranHeaders, 'idempotency-key': `cancel-${randomUUID()}` },
    payload: { reason: 'withdrawn before resolving' },
  });
  return { responder, headers };
}

describe('POST /api/v0/cases/:id/commands/resolve', () => {
  it('resolves an ACTIVE case, replays idempotency, and exposes settlements', async () => {
    const { tenantId, veteran, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const { responder, headers } = await claimAndActivate(
      tenantId,
      supportCase.caseId,
      veteranHeaders,
    );
    const key = `resolve-${randomUUID()}`;
    const payload = settlementPayload(responder.userId);

    const resolved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/resolve`,
      headers: { ...headers, 'idempotency-key': key },
      payload,
    });
    expect(resolved.statusCode).toBe(200);
    const body: {
      status: string;
      settlement_id: string;
      resolution_cycle: number;
      replayed: boolean;
    } = resolved.json();
    expect(body).toMatchObject({
      status: 'RESOLVED',
      resolution_cycle: 1,
      replayed: false,
    });
    expect(body.settlement_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    const replay = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/resolve`,
      headers: { ...headers, 'idempotency-key': key },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      settlement_id: body.settlement_id,
      resolution_cycle: 1,
      replayed: true,
    });

    const conflict = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/resolve`,
      headers: { ...headers, 'idempotency-key': key },
      payload: {
        ...payload,
        unresolved: { notes: 'different payload' },
      },
    });
    expect(conflict.statusCode).toBe(409);

    const listed = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/settlements`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().settlements).toHaveLength(1);
    expect(listed.json().settlements[0]).toMatchObject({
      settlement_id: body.settlement_id,
      occurred: { contact_attempts: 1, assignments: 1 },
      authored_by: responder.userId,
    });

    const veteranList = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/settlements`,
      headers: veteranHeaders,
    });
    expect(veteranList.statusCode).toBe(200);
    expect(veteranList.json().settlements[0].occurred).toBeUndefined();
    expect(veteranList.json().settlements[0].authored_by).toBeUndefined();
    expect(veteranList.json().settlements[0].settlement_id).toBe(body.settlement_id);

    const one = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/settlements/${body.settlement_id}`,
      headers: veteranHeaders,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json().settlement_id).toBe(body.settlement_id);
    expect(veteran.userId).toBeDefined();
  });

  it('takes the author and accepter from the session, not from the request body', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const { responder, headers } = await claimAndActivate(
      tenantId,
      supportCase.caseId,
      veteranHeaders,
    );
    const forged = randomUUID();

    const resolved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/resolve`,
      headers: { ...headers, 'idempotency-key': `forged-${randomUUID()}` },
      payload: {
        ...settlementPayload(forged),
        authored_by: forged,
        accepted_by_user_id: forged,
        veteran_confirmed_by: forged,
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().settlement).toMatchObject({
      authored_by: responder.userId,
      accepted_by_user_id: responder.userId,
      veteran_confirmed_by: null,
    });
  });

  it('requires Idempotency-Key and hides the case from anyone who did not accept it', async () => {
    const { tenantId, supportCase, headers: veteranHeaders } = await openRedCase(app);
    const assigned = await claimAndActivate(tenantId, supportCase.caseId, veteranHeaders);
    const other = await accepterFor(tenantId);

    const missingKey = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/resolve`,
      headers: assigned.headers,
      payload: settlementPayload(assigned.responder.userId),
    });
    expect(missingKey.statusCode).toBe(400);

    const forbidden = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${supportCase.caseId}/commands/resolve`,
      headers: { ...other.headers, 'idempotency-key': `other-${randomUUID()}` },
      payload: settlementPayload(other.responder.userId),
    });
    expect(forbidden.statusCode).toBe(404);
  });

  it('hides foreign-tenant cases (cross-tenant isolation)', async () => {
    const a = await openRedCase(app);
    const b = await openRedCase(app);
    const { headers } = await claimAndActivate(a.tenantId, a.supportCase.caseId, a.headers);

    const foreign = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${b.supportCase.caseId}/commands/resolve`,
      headers: { ...headers, 'idempotency-key': `foreign-${randomUUID()}` },
      payload: settlementPayload(randomUUID()),
    });
    expect(foreign.statusCode).toBe(404);

    const foreignList = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${b.supportCase.caseId}/settlements`,
      headers,
    });
    expect(foreignList.statusCode).toBe(404);
  });
});
