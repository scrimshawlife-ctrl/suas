/**
 * POST /veterans/me/verification/va/confirm and the gate it opens (suas-specs #72 R9.1,
 * proposal; D035_VA_CONFIRMATION_ADAPTER.md §9, §12, §13). The fixture adapter answers by
 * ZIP; the privacy test uses the HTTP adapter with a fake transport. Synthetic people
 * only. Requires PostgreSQL.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createServer } from '../../src/http/server.js';
import { createUser, VA_CONFIRMATION_FIXTURE_ZIPS } from '../../src/identity/index.js';
import {
  createVaConfirmationHttpAdapter,
  type VaConfirmationLogRecord,
} from '../../src/identity/va-confirmation-http.js';
import { VA_CONFIRMATION_SANDBOX_BASE_URL } from '../../src/identity/va-confirmation.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

let app: StartedApp;
let disabledApp: StartedApp;

const env = (extra: Record<string, string>) =>
  validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl(), ...extra });

beforeAll(async () => {
  app = await startApp({ env: env({ SUAS_VA_CONFIRMATION_MODE: 'fixture' }), listen: false });
  disabledApp = await startApp({ env: env({}), listen: false });
});

afterAll(async () => {
  await disabledApp.close();
  await app.close();
});

const body = (zipCode: string) => ({
  firstName: 'Testfirst',
  lastName: 'Testlast',
  birthDate: '1960-02-29',
  streetAddressLine1: '1 Example Way',
  city: 'Exampleton',
  state: 'CA',
  zipCode,
});

async function person(started: StartedApp = app) {
  const pool = started.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vac-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId });
  const headers = { authorization: `Bearer ${session.credential}` };
  const attempts = async () =>
    (
      await pool.query(
        `SELECT 1 FROM veteran_verifications
         WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'`,
        [tenantId, user.userId],
      )
    ).rowCount;
  return { pool, tenantId, user, headers, attempts };
}

function confirm(
  headers: Record<string, string>,
  payload: object,
  key: string = randomUUID(),
  started: StartedApp = app,
) {
  return started.server.inject({
    method: 'POST',
    url: '/api/v0/veterans/me/verification/va/confirm',
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });
}

const resources = (headers: Record<string, string>) =>
  app.server.inject({ method: 'GET', url: '/api/v0/resources', headers });
const me = async (headers: Record<string, string>) =>
  (await app.server.inject({ method: 'GET', url: '/api/v0/veterans/me', headers })).json<{
    id_verification: Record<string, unknown>;
  }>().id_verification;

describe('confirm and the gate', () => {
  it('blocks before any attempt and opens once VERIFIED', async () => {
    const { headers } = await person();
    expect(await me(headers)).toEqual({
      method: 'VA_VETERAN_STATUS',
      status: 'NOT_STARTED',
      not_confirmed_reason: null,
      verified_at: null,
    });
    expect((await resources(headers)).statusCode).toBe(403);

    const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(response.statusCode).toBe(200);
    const result = response.json<{ status: string; verified_at: string }>();
    expect(result).toMatchObject({ status: 'VERIFIED', not_confirmed_reason: null });
    expect(Date.parse(result.verified_at)).not.toBeNaN();
    expect(await me(headers)).toMatchObject({ method: 'VA_VETERAN_STATUS', status: 'VERIFIED' });
    expect((await resources(headers)).statusCode).toBe(200);
  });

  it.each([
    [VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38, 'NOT_CONFIRMED', 'NOT_TITLE_38'],
    [VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND, 'NOT_CONFIRMED', 'PERSON_NOT_FOUND'],
    [VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR, 'UNAVAILABLE', 'ERROR'],
  ])('ZIP %s settles %s (%s) and keeps the gate closed', async (zip, status, reason) => {
    const { headers } = await person();
    const response = await confirm(headers, body(zip));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status, not_confirmed_reason: reason, verified_at: null });
    expect(await me(headers)).toMatchObject({ status, not_confirmed_reason: reason });
    expect((await resources(headers)).statusCode).toBe(403);
  });

  it('keeps earlier results and lets a corrected retry pass', async () => {
    const { headers, attempts } = await person();
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND));
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(await attempts()).toBe(2);
    expect((await resources(headers)).statusCode).toBe(200);
  });

  it('replays the same Idempotency-Key with the same answer and one attempt', async () => {
    const { headers, attempts } = await person();
    const key = randomUUID();
    const first = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38), key);
    const second = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38), key);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(await attempts()).toBe(1);

    const changed = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED), key);
    expect(changed.statusCode).toBe(409);
  });

  it('refuses the sixth attempt in 24 hours with 429', async () => {
    const { headers, attempts } = await person();
    for (let i = 0; i < 5; i += 1) {
      const response = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND));
      expect(response.statusCode).toBe(200);
    }
    const sixth = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json<{ error: { code: string } }>().error.code).toBe('VERIFICATION_ATTEMPT_LIMIT');
    expect(Number(sixth.headers['retry-after'])).toBeGreaterThan(0);
    expect(await attempts()).toBe(5);
    expect((await resources(headers)).statusCode).toBe(403);
  });

  it('answers an already VERIFIED person without a new attempt', async () => {
    const { headers, attempts } = await person();
    await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    const again = await confirm(headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'VERIFIED' });
    expect(await attempts()).toBe(1);
  });

  it("does not show one person's result to another", async () => {
    const a = await person();
    const b = await person();
    await confirm(a.headers, body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED));
    expect(await me(b.headers)).toMatchObject({ status: 'NOT_STARTED' });
    expect((await resources(b.headers)).statusCode).toBe(403);
  });
});

describe('confirm request checks', () => {
  it('needs a session, an Idempotency-Key and a valid projection', async () => {
    const { headers, attempts } = await person();
    const valid = body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED);
    const unauthenticated = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/va/confirm',
      payload: valid,
    });
    expect(unauthenticated.statusCode).toBe(401);

    const noKey = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/va/confirm',
      headers,
      payload: valid,
    });
    expect(noKey.statusCode).toBe(400);

    for (const payload of [
      { ...valid, ssn: '000-00-0000' },
      { ...valid, country: 'MEX' },
      { ...valid, birthDate: '2999-01-01' },
      { ...valid, birthDate: '1990-02-30' },
      { ...valid, firstName: 'R2D2' },
      { ...valid, zipCode: '' },
    ]) {
      const response = await confirm(headers, payload);
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    }
    expect((await confirm(headers, { ...valid, country: 'USA' })).statusCode).toBe(200);
    expect(await attempts()).toBe(1);
  });

  it('answers 503 when confirmation is disabled', async () => {
    const { headers } = await person(disabledApp);
    const response = await confirm(
      headers,
      body(VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED),
      randomUUID(),
      disabledApp,
    );
    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'ID_VERIFICATION_UNAVAILABLE',
    );
  });
});

describe('projection values are never kept (R9.1 storage rule, D035 §13)', () => {
  it('leaves no sentinel in logs, rows, idempotency records or responses', async () => {
    const sentinel = {
      firstName: 'Zqxsentinelfirst',
      lastName: 'Zqxsentinellast',
      birthDate: '1931-07-13',
      streetAddressLine1: '999 Zqxsentinel Street',
      city: 'Zqxsentinelcity',
      state: 'Zqxsentinelstate',
      zipCode: 'ZQX99',
    };
    const lines: string[] = [];
    const adapterLogs: VaConfirmationLogRecord[] = [];
    let sentToVa = '';
    const port = createVaConfirmationHttpAdapter({
      baseUrl: VA_CONFIRMATION_SANDBOX_BASE_URL,
      apiKey: 'synthetic-key-not-real',
      environment: 'SANDBOX',
      logger: (record) => adapterLogs.push(record),
      transport: {
        fetch(_url, init) {
          sentToVa = init.body as string;
          return Promise.resolve(
            new Response(JSON.stringify({ veteran_status: 'confirmed' }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      },
    });
    const server = createServer({
      config: { ...app.config, logLevel: 'trace' },
      buildInfo: () => app.buildInfo,
      pool: app.pool!,
      veteranConfirmation: port,
      logStream: { write: (line) => void lines.push(line) },
    });
    const consoleLines: unknown[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args) => void consoleLines.push(args)),
    );

    try {
      const { headers, pool, tenantId } = await person();
      const post = (payload: object) =>
        server.inject({
          method: 'POST',
          url: '/api/v0/veterans/me/verification/va/confirm',
          headers: { ...headers, 'idempotency-key': randomUUID() },
          payload,
        });
      // A refused body (unknown key) and an accepted one both carry the sentinels.
      const refused = await post({ ...sentinel, extra: sentinel.lastName });
      expect(refused.statusCode).toBe(400);
      const accepted = await post(sentinel);
      expect(accepted.statusCode).toBe(200);
      expect(JSON.parse(sentToVa)).toMatchObject({ firstName: sentinel.firstName });

      const dump = async (table: string, where: string) =>
        JSON.stringify(
          (await pool.query(`SELECT * FROM ${table} WHERE ${where}`, [tenantId])).rows,
        );
      const stored = [
        await dump('veteran_verifications', 'tenant_id = $1'),
        await dump('audit_events', 'tenant_id = $1'),
        await dump('domain_events', 'tenant_id = $1'),
        await dump('command_idempotency_records', 'tenant_id = $1'),
      ];
      expect(stored[1]).toContain('VETERAN_VERIFICATION_SETTLED');
      expect(stored[3]).toContain('VERIFIED');

      const everything = [
        ...lines,
        JSON.stringify(consoleLines),
        JSON.stringify(adapterLogs),
        refused.body,
        accepted.body,
        ...stored,
      ].join('\n');
      expect(lines.length).toBeGreaterThan(0);
      for (const value of Object.values(sentinel)) {
        expect(everything).not.toContain(value);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
      await server.close();
    }
  });
});
