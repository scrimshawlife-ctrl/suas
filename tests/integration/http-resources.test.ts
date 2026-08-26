/**
 * Resource catalog and immediate-resource JSON API (requires PostgreSQL).
 *
 * SUAS-specs APIS.md §2.4; RESOURCES.md §6 / §8 / §10; SAFETY_COPY.md §1.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { withTransaction } from '../../src/db/index.js';
import {
  createResource,
  setResourceActive,
  verifyResource,
  type Resource,
} from '../../src/fulfillment/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

let app: StartedApp;
let approvedApp: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl() }),
    listen: false,
  });
  approvedApp = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_SAFETY_COPY_MODE: 'approved',
    }),
    listen: false,
  });
});

afterAll(async () => {
  await approvedApp.close();
  await app.close();
});

async function sessionFor(tenantId: string, userId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId });
  return { authorization: `Bearer ${session.credential}` };
}

async function veteranInTenant() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const headers = await sessionFor(tenantId, user.userId);
  return { tenantId, user, headers };
}

async function activeResource(
  tenantId: string,
  actorId: string,
  input: {
    serviceName: string;
    category: 'FOOD' | 'TRANSPORTATION' | 'SHELTER' | 'PEER_SUPPORT';
    counties?: readonly string[];
    contactMethod?: string;
    contactMethodKind?: 'PHONE' | 'EMAIL' | 'URL' | 'FREEFORM';
    hours?: string;
    cost?: string;
    eligibility?: string;
  },
): Promise<Resource> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const created = await createResource(pool, { tenantId, ...input });
  return withTransaction(pool, async (tx) => {
    await verifyResource(tx, {
      tenantId,
      resourceId: created.resourceId,
      verificationSource: 'synthetic-http-resources-test',
      actorId,
    });
    return setResourceActive(tx, {
      tenantId,
      resourceId: created.resourceId,
      active: true,
      actorId,
    });
  });
}

describe('GET /api/v0/resources', () => {
  it('lists active tenant resources without internal fields', async () => {
    const { tenantId, user, headers } = await veteranInTenant();
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');

    const pantry = await activeResource(tenantId, user.userId, {
      serviceName: 'Neighborhood Pantry',
      category: 'FOOD',
      counties: ['Santa Clara'],
      contactMethod: 'front desk',
      contactMethodKind: 'FREEFORM',
      hours: 'Mon–Fri 9–5',
      cost: 'Free',
      eligibility: 'internal note must not leak',
    });
    // Created but never activated — must not appear in the active catalog.
    await createResource(pool, {
      tenantId,
      serviceName: 'Inactive Pantry',
      category: 'FOOD',
    });

    const otherTenant = randomUUID();
    const otherUser = await createUser(pool, {
      tenantId: otherTenant,
      email: syntheticEmail(`other-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await activeResource(otherTenant, otherUser.userId, {
      serviceName: 'Other Tenant Pantry',
      category: 'FOOD',
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/resources?category=FOOD&limit=20',
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body: {
      resources: Record<string, unknown>[];
      limit: number;
    } = response.json();
    expect(body.limit).toBe(20);
    expect(body.resources.map((row) => row.resource_id)).toEqual([pantry.resourceId]);
    const row = body.resources[0];
    expect(row).toMatchObject({
      resource_id: pantry.resourceId,
      service_name: 'Neighborhood Pantry',
      category: 'FOOD',
      counties: ['Santa Clara'],
      hours: 'Mon–Fri 9–5',
      cost: 'Free',
      contact_method: 'front desk',
      contact_method_kind: 'FREEFORM',
      freshness: 'FRESH',
      stale_warning: false,
    });
    expect(row).not.toHaveProperty('eligibility');
    expect(row).not.toHaveProperty('verification_source');
    expect(row).not.toHaveProperty('integration_modes');
  });

  it('requires authentication', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/resources' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });
});

describe('GET /api/v0/resources/:id', () => {
  it('returns one active resource and hides other tenants', async () => {
    const { tenantId, user, headers } = await veteranInTenant();
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const resource = await activeResource(tenantId, user.userId, {
      serviceName: 'Ride Desk',
      category: 'TRANSPORTATION',
    });
    const foreignTenant = randomUUID();
    const foreignUser = await createUser(pool, {
      tenantId: foreignTenant,
      email: syntheticEmail(`foreign-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const foreign = await activeResource(foreignTenant, foreignUser.userId, {
      serviceName: 'Foreign Ride',
      category: 'TRANSPORTATION',
    });

    const ok = await app.server.inject({
      method: 'GET',
      url: `/api/v0/resources/${resource.resourceId}`,
      headers,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      resource_id: resource.resourceId,
      service_name: 'Ride Desk',
      category: 'TRANSPORTATION',
    });

    const leak = await app.server.inject({
      method: 'GET',
      url: `/api/v0/resources/${foreign.resourceId}`,
      headers,
    });
    expect(leak.statusCode).toBe(404);
    expect(leak.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('returns 404 for inactive resources in the same tenant', async () => {
    const { tenantId, headers } = await veteranInTenant();
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const resource = await createResource(pool, {
      tenantId,
      serviceName: 'Closed Shelter Slot',
      category: 'SHELTER',
    });
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/v0/resources/${resource.resourceId}`,
      headers,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/v0/immediate-resources', () => {
  it('returns the placeholder slot when safety copy is not approved', async () => {
    const { headers } = await veteranInTenant();
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/immediate-resources',
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.state).toBe('PLACEHOLDER');
    expect(body.resources).toEqual([]);
    expect(body.placeholder).toContain('not available');
  });

  it('returns approved 911/988 destinations when safety copy mode is approved', async () => {
    const pool = approvedApp.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const response = await approvedApp.server.inject({
      method: 'GET',
      url: '/api/v0/immediate-resources',
      headers: { authorization: `Bearer ${session.credential}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.state).toBe('APPROVED');
    expect(body.resources).toEqual([
      {
        label: 'Call 911',
        destination: 'tel:911',
        approved_under: 'SAFETY_COPY.md §1.1 (D-012, v0.1.5)',
      },
      {
        label: 'Call or text 988',
        destination: 'tel:988',
        approved_under: 'SAFETY_COPY.md §1.1 (D-012, v0.1.5)',
      },
    ]);
  });
});
