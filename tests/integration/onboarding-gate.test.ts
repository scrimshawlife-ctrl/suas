/**
 * County, the Veteran confirmation flow, and the verified-Veteran gate (V1_PROJECT_PLAN.md
 * §2.1, §4.3 F1/F2/F10). The gate is now a VERIFIED VA Veteran Confirmation (suas-specs #72
 * R9.1) in place of the ID scan + selfie; the flow tests below keep the properties the ID
 * scan tests checked. Route edge cases are in va-confirmation.test.ts. Requires PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import {
  createUser,
  setUserDisplayName,
  VA_CONFIRMATION_FIXTURE_ZIPS,
  VA_NOTICE_V1,
} from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { closeVaOutageCooldown } from '../helpers/db.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

let app: StartedApp;
let appWithoutConfirmation: StartedApp;

const env = (extra: Record<string, string>) =>
  validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl(), ...extra });

beforeAll(async () => {
  app = await startApp({ env: env({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }), listen: false });
  appWithoutConfirmation = await startApp({ env: env({}), listen: false });
  await closeVaOutageCooldown(app.pool!);
});

afterAll(async () => {
  await appWithoutConfirmation.close();
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
  // The confirm route needs the typed name to match the account name.
  await setUserDisplayName(pool, tenantId, user.userId, 'Synthetic V.');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  return { pool, tenantId, user, headers: { authorization: `Bearer ${session.credential}` } };
}

/** A REVOKED row outranks any VERIFIED one, so the gate closes at once. */
async function revokeStanding(pool: Pool, tenantId: string, userId: string): Promise<void> {
  await pool.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
      provider_environment, projection_id, settled_at)
     VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'REVOKED', 'SUAS', 'test', 'NONE',
             'VA_CONFIRMATION_V1_REQUIRED_ONLY', now())`,
    [randomUUID(), tenantId, userId],
  );
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

/** One confirm call with a synthetic person; the fixture answers by ZIP. */
const confirm = (headers: Record<string, string>, zipCode: string, started: StartedApp = app) =>
  started.server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/va/confirm',
    headers: { ...headers, 'idempotency-key': randomUUID() },
    payload: {
      firstName: 'Synthetic',
      lastName: 'Veteran',
      birthDate: '1970-01-01',
      streetAddressLine1: '1 Example Way',
      city: 'Exampleton',
      state: 'CA',
      zipCode,
      noticeVersion: VA_NOTICE_V1,
    },
  });

const standing = async (headers: Record<string, string>) =>
  (await app.server.inject({ method: 'GET', url: '/api/v0/veterans/me', headers })).json<{
    id_verification: { status: string; verified_at: string | null };
  }>().id_verification;

const resources = (headers: Record<string, string>) =>
  app.server.inject({ method: 'GET', url: '/api/v0/resources', headers });

const attemptCount = async (pool: Pool, tenantId: string, userId: string) =>
  (
    await pool.query(
      `SELECT 1 FROM veteran_verifications
       WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'`,
      [tenantId, userId],
    )
  ).rowCount;

describe('Veteran confirmation flow over HTTP (fixture answers at once)', () => {
  it('confirms, shows the standing on the me view, and does not take a second attempt', async () => {
    const { headers, pool, tenantId, user } = await person();

    const first = await confirm(headers, VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED);
    expect(first.statusCode).toBe(200);
    expect(first.json<{ status: string }>().status).toBe('VERIFIED');
    const again = await confirm(headers, VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ status: string }>().status).toBe('VERIFIED');

    expect((await standing(headers)).status).toBe('VERIFIED');
    expect(await attemptCount(pool, tenantId, user.userId)).toBe(1);
  });

  it('reads NOT_STARTED before any attempt, and 503 when no provider is configured', async () => {
    const { headers } = await person();
    expect((await standing(headers)).status).toBe('NOT_STARTED');

    const disabled = await person(appWithoutConfirmation);
    const response = await confirm(
      disabled.headers,
      VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED,
      appWithoutConfirmation,
    );
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'ID_VERIFICATION_UNAVAILABLE',
    );
  });
});

describe('Veteran confirmation outcomes', () => {
  it('moves to VERIFIED or NOT_CONFIRMED only when VA answers, and a retry can pass', async () => {
    const { headers } = await person();

    const notFound = await confirm(headers, VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND);
    expect(notFound.json<{ status: string }>().status).toBe('NOT_CONFIRMED');
    expect((await standing(headers)).status).toBe('NOT_CONFIRMED');
    expect((await resources(headers)).statusCode).toBe(403);

    // A person who was not confirmed may try again; the new attempt can pass.
    const retry = await confirm(headers, VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED);
    expect(retry.json<{ status: string }>().status).toBe('VERIFIED');
    const done = await standing(headers);
    expect(done.status).toBe('VERIFIED');
    expect(done.verified_at).not.toBeNull();
    expect((await resources(headers)).statusCode).toBe(200);
  });

  it('reports unavailable when VA is down, keeps the gate closed, and a later attempt can pass', async () => {
    const { headers } = await person();

    const down = await confirm(headers, VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR);
    expect(down.statusCode).toBe(200);
    expect(down.json<{ status: string }>().status).toBe('UNAVAILABLE');
    expect((await resources(headers)).statusCode).toBe(403);

    const later = await confirm(headers, VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED);
    expect(later.json<{ status: string }>().status).toBe('VERIFIED');
  });
});

describe('verified-Veteran gate', () => {
  it('blocks a signed-in person with no confirmation from every Veteran-only route', async () => {
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

    // Check-Ins and Resources need the confirmation but not a county.
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
    await revokeStanding(pool, tenantId, user.userId);
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/resources', headers });
    expect(response.statusCode).toBe(403);
  });

  // R12.8: of the request commands only the requester's SUBMIT needs the confirmation.
  it('refuses the requester SUBMIT once the standing is revoked', async () => {
    const { headers, pool, tenantId, user } = await person();
    await markVerifiedVeteran(pool, tenantId, user.userId);
    const keyed = () => ({ ...headers, 'idempotency-key': randomUUID() });
    const opened = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: keyed(),
    });
    const created = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${opened.json<{ case_id: string }>().case_id}/service-requests`,
      headers: keyed(),
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json<{ service_request_id: string }>().service_request_id;
    await revokeStanding(pool, tenantId, user.userId);

    const submitted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/commands/SUBMIT`,
      headers: keyed(),
      payload: {},
    });
    expect(submitted.statusCode).toBe(403);
    expect(submitted.json<{ error: { code: string } }>().error.code).toBe('VERIFICATION_REQUIRED');
  });
});

describe('helping others needs no confirmation', () => {
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
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    const requestId = created.json<{ service_request_id: string }>().service_request_id;
    await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${requestId}/commands/SUBMIT`,
      headers: { ...requester.headers, 'idempotency-key': randomUUID() },
      payload: {},
    });

    // The helper list needs a county, and says so; it does not need a confirmation.
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
  it('is public: signed out, with no confirmation, and with no database session', async () => {
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
