/**
 * County, the ID scan + selfie check, and the verified-Veteran gate
 * (V1_PROJECT_PLAN.md §2.1, §4.3 F1/F2/F10). Requires PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import {
  createUser,
  FakeIdVerification,
  readIdScanStatus,
  startIdScan,
  IdVerificationUnavailableError,
} from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

let app: StartedApp;
let appWithoutScan: StartedApp;

const env = (extra: Record<string, string>) =>
  validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl(), ...extra });

beforeAll(async () => {
  app = await startApp({ env: env({ SUAS_ID_VERIFICATION_MODE: 'fake' }), listen: false });
  appWithoutScan = await startApp({ env: env({}), listen: false });
});

afterAll(async () => {
  await appWithoutScan.close();
  await app.close();
});

async function person(started: StartedApp = app) {
  const pool = started.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`onb-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  return { pool, tenantId, user, headers: { authorization: `Bearer ${session.credential}` } };
}

describe('county', () => {
  it('is null until chosen, can be set and changed, and rejects anything outside the seven', async () => {
    const { headers } = await person();
    const me = () => app.server.inject({ method: 'GET', url: '/api/v0/veterans/me', headers });

    expect((await me()).json<{ county: string | null }>().county).toBeNull();

    const set = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/county',
      headers,
      payload: { county: 'ALAMEDA' },
    });
    expect(set.statusCode).toBe(200);
    expect((await me()).json<{ county: string }>().county).toBe('ALAMEDA');

    const changed = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/county',
      headers,
      payload: { county: 'MERCED' },
    });
    expect(changed.json<{ county: string }>().county).toBe('MERCED');

    for (const payload of [{ county: 'SAN_FRANCISCO' }, { county: '' }, {}]) {
      const bad = await app.server.inject({
        method: 'PUT',
        url: '/api/v0/veterans/me/county',
        headers,
        payload,
      });
      expect(bad.statusCode).toBe(400);
    }
    expect((await me()).json<{ county: string }>().county).toBe('MERCED');
  });

  it('requires a session', async () => {
    const response = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/county',
      payload: { county: 'ALAMEDA' },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('ID scan + selfie flow over HTTP (config fake passes immediately)', () => {
  it('starts, shows the standing on the me view, and does not open a second check', async () => {
    const { headers, pool, tenantId, user } = await person();
    const start = () =>
      app.server.inject({
        method: 'POST',
        url: '/api/v0/veterans/me/id-verification/commands/start',
        headers,
      });

    const first = await start();
    expect(first.statusCode).toBe(201);
    expect(first.json<{ method: string; status: string }>()).toMatchObject({
      method: 'ID_SCAN_SELFIE',
      status: 'VERIFIED',
    });
    expect((await start()).statusCode).toBe(200);

    const me = await app.server.inject({ method: 'GET', url: '/api/v0/veterans/me', headers });
    expect(me.json<{ id_verification: { status: string } }>().id_verification.status).toBe(
      'VERIFIED',
    );
    const rows = await pool.query(
      `SELECT 1 FROM veteran_verifications WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, user.userId],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('reads NOT_STARTED before any check, and 503 when no provider is configured', async () => {
    const { headers } = await person();
    const status = await app.server.inject({
      method: 'GET',
      url: '/api/v0/veterans/me/id-verification',
      headers,
    });
    expect(status.json<{ status: string }>().status).toBe('NOT_STARTED');

    const disabled = await person(appWithoutScan);
    const start = await appWithoutScan.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/id-verification/commands/start',
      headers: disabled.headers,
    });
    expect(start.statusCode).toBe(503);
    expect(start.json<{ error: { code: string } }>().error.code).toBe(
      'ID_VERIFICATION_UNAVAILABLE',
    );
  });
});

describe('ID scan + selfie flow with a controllable port', () => {
  it('moves PENDING to VERIFIED or NOT_CONFIRMED only when the port answers', async () => {
    const { pool, tenantId, user } = await person();
    const port = new FakeIdVerification();

    const started = await startIdScan(pool, port, tenantId, user.userId);
    expect(started).toMatchObject({ created: true, view: { status: 'PENDING' } });
    // A retried start reuses the pending check.
    expect((await startIdScan(pool, port, tenantId, user.userId)).created).toBe(false);
    expect((await readIdScanStatus(pool, port, tenantId, user.userId)).status).toBe('PENDING');

    port.resolve('fake-id-check-1', 'NOT_CONFIRMED');
    expect((await readIdScanStatus(pool, port, tenantId, user.userId)).status).toBe(
      'NOT_CONFIRMED',
    );

    // A person who was not confirmed may try again; the new check can pass.
    const retry = await startIdScan(pool, port, tenantId, user.userId);
    expect(retry).toMatchObject({ created: true, view: { status: 'PENDING' } });
    port.resolve('fake-id-check-2', 'VERIFIED');
    const done = await readIdScanStatus(pool, port, tenantId, user.userId);
    expect(done.status).toBe('VERIFIED');
    expect(done.verifiedAt).toBeInstanceOf(Date);
  });

  it('reports unavailable when the provider is down and keeps a pending check pending', async () => {
    const { pool, tenantId, user } = await person();
    const port = new FakeIdVerification();

    port.setAvailable(false);
    await expect(startIdScan(pool, port, tenantId, user.userId)).rejects.toBeInstanceOf(
      IdVerificationUnavailableError,
    );

    port.setAvailable(true);
    await startIdScan(pool, port, tenantId, user.userId);
    port.setAvailable(false);
    expect((await readIdScanStatus(pool, port, tenantId, user.userId)).status).toBe('PENDING');
  });
});

describe('verified-Veteran gate', () => {
  it('blocks a signed-in person with no passed scan from every Veteran-only route', async () => {
    const { headers, tenantId } = await person();
    const id = randomUUID();
    const routes: { method: 'GET' | 'POST'; url: string; payload?: object }[] = [
      { method: 'POST', url: '/api/v0/cases' },
      { method: 'POST', url: '/api/v0/check-ins' },
      { method: 'GET', url: `/api/v0/check-ins/${id}` },
      { method: 'GET', url: '/api/v0/resources' },
      { method: 'GET', url: `/api/v0/resources/${id}` },
      { method: 'GET', url: '/api/v0/trusted-contacts' },
      { method: 'POST', url: '/api/v0/trusted-contacts', payload: {} },
      { method: 'GET', url: '/api/v0/consents' },
      { method: 'POST', url: '/api/v0/consents', payload: {} },
    ];
    for (const route of routes) {
      const response = await app.server.inject({
        ...route,
        headers: { ...headers, 'idempotency-key': randomUUID() },
      });
      expect(response.statusCode, `${route.method} ${route.url} (${tenantId})`).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VERIFICATION_REQUIRED');
    }
  });

  it('lets a verified person with a county through, and asks for a county when missing', async () => {
    const { headers, pool, tenantId, user } = await person();
    await markVerifiedVeteran(pool, tenantId, user.userId, null);

    const idempotent = { ...headers, 'idempotency-key': randomUUID() };
    const noCounty = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: idempotent,
    });
    expect(noCounty.statusCode).toBe(422);
    expect(noCounty.json<{ error: { code: string } }>().error.code).toBe('COUNTY_REQUIRED');

    // Check-Ins and Resources need the scan but not a county.
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v0/resources', headers })).statusCode,
    ).toBe(200);

    await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/county',
      headers,
      payload: { county: 'SANTA_CRUZ' },
    });
    const opened = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: idempotent,
    });
    expect(opened.statusCode).toBe(201);
  });

  it('stops working when the standing is revoked', async () => {
    const { headers, pool, tenantId, user } = await person();
    await markVerifiedVeteran(pool, tenantId, user.userId);
    await pool.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version)
       VALUES ($1, $2, $3, 'ID_SCAN_SELFIE', 'REVOKED', 'SUAS', 'test')`,
      [randomUUID(), tenantId, user.userId],
    );
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/resources', headers });
    expect(response.statusCode).toBe(403);
  });
});

describe('helping others needs no scan', () => {
  it("lets an unverified person list, and accept, a verified requester's request", async () => {
    const tenantId = randomUUID();
    const make = async (county: string | null) => {
      const user = await createUser(app.pool!, {
        tenantId,
        email: syntheticEmail(`help-${randomUUID().slice(0, 8)}`),
        status: 'ACTIVE',
      });
      const session = await createSession(app.pool!, TEST_SESSION_SECRET, {
        tenantId,
        userId: user.userId,
      });
      if (county !== null) {
        await app.pool!.query(
          `UPDATE users SET county = $3 WHERE tenant_id = $1 AND user_id = $2`,
          [tenantId, user.userId, county],
        );
      }
      return { user, headers: { authorization: `Bearer ${session.credential}` } };
    };
    const requester = await make('SANTA_CLARA');
    await markVerifiedVeteran(app.pool!, tenantId, requester.user.userId);
    const helper = await make(null);
    const keyed = { ...requester.headers, 'idempotency-key': randomUUID() };
    const opened = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: keyed,
    });
    const caseId = opened.json<{ case_id: string }>().case_id;
    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/service-requests`,
      headers: { ...requester.headers, 'idempotency-key': randomUUID() },
      payload: { category: 'FOOD' },
    });
    const requestId = created.json<{ service_request_id: string }>().service_request_id;
    await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/commands/SUBMIT`,
      headers: { ...requester.headers, 'idempotency-key': randomUUID() },
      payload: {},
    });

    // The helper list needs a county, and says so; it does not need a scan.
    const noCounty = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open',
      headers: helper.headers,
    });
    expect(noCounty.statusCode).toBe(422);
    expect(noCounty.json<{ error: { code: string } }>().error.code).toBe('COUNTY_REQUIRED');

    await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/county',
      headers: helper.headers,
      payload: { county: 'SANTA_CLARA' },
    });
    const list = await app.server.inject({
      method: 'GET',
      url: '/api/v0/service-requests?ownership=open',
      headers: helper.headers,
    });
    expect(list.statusCode).toBe(200);
    expect(
      list
        .json<{ service_requests: { service_request_id: string }[] }>()
        .service_requests.map((item) => item.service_request_id),
    ).toContain(requestId);

    const accepted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/accept`,
      headers: helper.headers,
    });
    expect(accepted.statusCode).toBe(200);
  });
});

describe('crisis screen', () => {
  it('is public: signed out, with no scan, and with no database session', async () => {
    const signedOut = await app.server.inject({
      method: 'GET',
      url: '/api/v0/immediate-resources',
    });
    expect(signedOut.statusCode).toBe(200);
    expect(['APPROVED', 'PLACEHOLDER']).toContain(signedOut.json<{ state: string }>().state);

    const page = await app.server.inject({ method: 'GET', url: '/app/immediate-resources' });
    expect(page.statusCode).toBe(200);

    const { headers } = await person();
    const unverified = await app.server.inject({
      method: 'GET',
      url: '/api/v0/immediate-resources',
      headers,
    });
    expect(unverified.statusCode).toBe(200);
  });
});
