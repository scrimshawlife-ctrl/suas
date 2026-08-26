/**
 * HTTP surface and startup-sequence evidence.
 *
 * SUAS-specs API.md §2 (version selector), §6 (error body), §8 (correlation);
 * SUAS-specs ENVIRONMENT.md §5 (startup fails closed), §8 (build-info surface).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { ConfigurationError } from '../../src/config/index.js';
import { EXPECTED_SCHEMA_VERSION } from '../../src/db/index.js';
import { createSession, elevateSession } from '../../src/auth/index.js';
import { createUser, grantSuasAdmin } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

/** Sign in a SUAS admin with an MFA-elevated session, as the admin surface requires. */
async function elevatedAdminCredential(elevate = true): Promise<string> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('The test app has no database pool.');

  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`admin-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await grantSuasAdmin(pool, user.userId, undefined);
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  if (elevate) await elevateSession(pool, session.session.sessionId);
  return session.credential;
}

/** A signed-in, non-admin, unelevated session. */
async function plainCredential(): Promise<string> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('The test app has no database pool.');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`user-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return session.credential;
}

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

describe('startup sequence', () => {
  it('fails closed before serving traffic when configuration is invalid', async () => {
    await expect(
      startApp({ env: validEnv({ SUAS_SUPPORT_SIGNAL_MODE: 'production' }), listen: false }),
    ).rejects.toThrow(ConfigurationError);
  });

  it('brings up the durable-work seam and reports it as non-durable in TEST', () => {
    expect(app.jobQueue.durability).toBe('non-durable');
  });
});

describe('GET /api/v0/health', () => {
  it('reports liveness and non-secret dependency posture', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      dependencies: {
        database: { status: 'configured' },
        job_queue: {
          status: 'configured',
          durability: 'non-durable',
          implementation: 'in-memory-fake',
        },
      },
    });
    expect(response.body).not.toContain('suas:suas');
    expect(response.body).not.toContain('DATABASE_URL');
    expect(response.body).not.toContain('SESSION_SECRET');
  });
});

describe('GET /api/v0/admin/build-info', () => {
  it('exposes the machine-readable provenance object to an elevated SUAS admin', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
      headers: { authorization: `Bearer ${await elevatedAdminCredential()}` },
    });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.spec_version).toBe('0.2.0');
    expect(body.release_manifest).toBe('RELEASE_MANIFEST-0.2.0.md');
    expect(body.api_version).toBe('v0');
    expect(body.event_schema_version).toBe('0.1.0');
    expect(body.schema_version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(body.environment).toBe('TEST');
    expect(body.production_readiness).toBe('NOT_READY');
  });

  it('carries no secret material', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
      headers: { authorization: `Bearer ${await elevatedAdminCredential()}` },
    });
    expect(response.body).not.toContain('suas:suas');
    expect(response.body).not.toContain('DATABASE_URL');
    expect(response.body).not.toContain(TEST_SESSION_SECRET);
  });

  // Slice 1 left this route unauthenticated and simply unregistered in
  // PRODUCTION. Slice 3 supplies the admin authorization it was waiting for.
  it('refuses an unauthenticated request', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a signed-in user who is not a SUAS admin', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
      headers: { authorization: `Bearer ${await plainCredential()}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('refuses a SUAS admin whose session is not MFA-elevated', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/build-info',
      headers: { authorization: `Bearer ${await elevatedAdminCredential(false)}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('MFA_REQUIRED');
  });
});

describe('GET /api/v0/admin/adapter-catalog', () => {
  it('lists installed adapters without secrets', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/adapter-catalog',
      headers: { authorization: `Bearer ${await elevatedAdminCredential()}` },
    });
    expect(response.statusCode).toBe(200);
    const adapters: { adapter_id: string }[] = response.json().adapters;
    const ids = adapters.map((entry) => entry.adapter_id).sort();
    expect(ids).toEqual([
      'food-manual',
      'peer-support-manual',
      'shelter-api',
      'shelter-manual',
      'transportation-api',
      'transportation-manual',
    ]);
    expect(response.body).not.toContain('client_secret');
    expect(response.body).not.toContain(TEST_SESSION_SECRET);
  });

  it('refuses a non-admin', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/adapter-catalog',
      headers: { authorization: `Bearer ${await plainCredential()}` },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('admin adapter configurations', () => {
  it('seeds manuals on list and enables a catalog API adapter only with secrets', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('The test app has no database pool.');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`admin-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await grantSuasAdmin(pool, user.userId, undefined);
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    await elevateSession(pool, session.session.sessionId);
    const headers = { authorization: `Bearer ${session.credential}` };

    const listed = await app.server.inject({
      method: 'GET',
      url: `/api/v0/admin/adapter-configurations?tenant_id=${tenantId}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().configurations).toHaveLength(4);

    const denied = await app.server.inject({
      method: 'POST',
      url: '/api/v0/admin/adapter-configurations/commands/enable',
      headers,
      payload: {
        tenant_id: tenantId,
        adapter_id: 'food-api',
        capability: 'FOOD',
      },
    });
    expect(denied.statusCode).toBe(403);

    const disableManual = await app.server.inject({
      method: 'POST',
      url: '/api/v0/admin/adapter-configurations/commands/disable',
      headers,
      payload: {
        tenant_id: tenantId,
        adapter_id: 'food-manual',
        capability: 'FOOD',
      },
    });
    expect(disableManual.statusCode).toBe(422);
  });
});

describe('API.md §6 — canonical error body', () => {
  it('returns the released error shape for an unknown route', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/not-a-route' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found.' },
    });
  });

  it('does not answer outside the /api/v0 version selector', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(404);
  });
});

describe('API.md §8 — request correlation', () => {
  it('echoes a supplied correlation id', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/health',
      headers: { 'x-request-id': 'corr-123' },
    });
    expect(response.headers['x-request-id']).toBe('corr-123');
  });

  it('generates an opaque correlation id when none is supplied', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/health' });
    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('rejects a malformed correlation id rather than reflecting it', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/health',
      headers: { 'x-request-id': 'veteran name <injected>' },
    });
    expect(response.headers['x-request-id']).not.toBe('veteran name <injected>');
  });
});
