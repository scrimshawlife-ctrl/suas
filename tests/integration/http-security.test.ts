/**
 * Adversarial HTTP security evidence (requires PostgreSQL).
 *
 * SUAS-specs SECURITY.md §2 / §5; AUTH.md §3; PRIVACY.md; API.md §4 / §6.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { CHALLENGE_ISSUE_LIMIT, createSession } from '../../src/auth/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

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

describe('SECURITY.md §2 — auth challenge abuse controls', () => {
  it('rate-limits challenge issuance per destination', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const email = syntheticEmail(`rate-${randomUUID().slice(0, 8)}`);
    await createUser(pool, { tenantId, email, status: 'ACTIVE' });

    let limitedStatus: number | undefined;
    let limitedCode: string | undefined;
    for (let attempt = 0; attempt < CHALLENGE_ISSUE_LIMIT.value + 2; attempt += 1) {
      const response = await app.server.inject({
        method: 'POST',
        url: '/api/v0/auth/challenges',
        payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
      });
      if (response.statusCode === 429) {
        limitedStatus = response.statusCode;
        limitedCode = response.json().error?.code as string;
        break;
      }
      expect([202, 429]).toContain(response.statusCode);
    }
    expect(limitedStatus).toBe(429);
    expect(limitedCode).toBe('RATE_LIMITED');
  });
});

describe('SECURITY.md §2 / PRIVACY.md — tenant isolation on self APIs', () => {
  it('does not leak another tenant veteran projection', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    const userA = await createUser(pool, {
      tenantId: tenantA,
      email: syntheticEmail(`a-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const userB = await createUser(pool, {
      tenantId: tenantB,
      email: syntheticEmail(`b-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const sessionA = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId: tenantA,
      userId: userA.userId,
    });
    const me = await app.server.inject({
      method: 'GET',
      url: '/api/v0/veterans/me',
      headers: { authorization: `Bearer ${sessionA.credential}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user_id).toBe(userA.userId);
    expect(me.json().user_id).not.toBe(userB.userId);
    expect(me.body).not.toContain(userB.email ?? 'missing');
    expect(me.body).not.toContain(userA.email ?? 'missing');
  });
});

describe('ENVIRONMENT.md §6 / §8 — response redaction', () => {
  it('keeps secrets out of health and error bodies', async () => {
    const health = await app.server.inject({ method: 'GET', url: '/api/v0/health' });
    expect(health.statusCode).toBe(200);
    expect(health.body).not.toContain('SESSION_SECRET');
    expect(health.body).not.toContain('suas:suas');
    expect(health.body).not.toContain(TEST_SESSION_SECRET);

    const missing = await app.server.inject({
      method: 'GET',
      url: '/api/v0/resources/not-a-uuid',
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.body).not.toContain(TEST_SESSION_SECRET);
    expect(missing.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('browser response hardening', () => {
  it('applies fail-closed security and cache headers to the web and API surfaces', async () => {
    const web = await app.server.inject({ method: 'GET', url: '/app' });
    expect(web.statusCode).toBe(200);
    expect(web.headers['content-security-policy']).toContain("script-src 'none'");
    expect(web.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(web.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(web.headers['x-content-type-options']).toBe('nosniff');
    expect(web.headers['x-frame-options']).toBe('DENY');
    expect(web.headers['referrer-policy']).toBe('no-referrer');
    expect(web.headers['cache-control']).toBe('no-store');

    const api = await app.server.inject({ method: 'GET', url: '/api/v0/health' });
    expect(api.statusCode).toBe(200);
    expect(api.headers['cache-control']).toBe('no-store');
    expect(api.headers['permissions-policy']).toContain('geolocation=()');
  });
});
