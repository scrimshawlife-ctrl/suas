/**
 * Opening a Support Case over /api/v0 (requires PostgreSQL).
 *
 * SUAS-specs CASES.md §3; API.md §7, §8. Listing and accepting requests is covered by
 * http-peer-accept.test.ts.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { createVerifiedUser } from '../helpers/verified-veteran.js';

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

async function bearer(tenantId: string, userId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId });
  return { authorization: `Bearer ${session.credential}` };
}

describe('POST /api/v0/cases', () => {
  it('opens one Veteran case and replays the authoritative result', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const veteran = await createVerifiedUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-open-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const headers = {
      ...(await bearer(tenantId, veteran.userId)),
      'idempotency-key': randomUUID(),
    };

    const opened = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers,
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({ status: 'OPEN', created: true, replayed: false });

    const replayed = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers,
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual({ ...opened.json(), replayed: true });

    const reused = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: { ...headers, 'idempotency-key': randomUUID() },
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({
      case_id: opened.json().case_id,
      status: 'OPEN',
      created: false,
      replayed: false,
    });
  });

  it('requires authentication and an idempotency key', async () => {
    const unauthenticated = await app.server.inject({ method: 'POST', url: '/api/v0/cases' });
    expect(unauthenticated.statusCode).toBe(401);

    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const veteran = await createVerifiedUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-key-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const missingKey = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: await bearer(tenantId, veteran.userId),
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe('VALIDATION_FAILED');
  });
});
