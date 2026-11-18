/**
 * Service Request JSON reads (requires PostgreSQL).
 *
 * SUAS-specs DISPATCH.md §1 / §4; API.md §4.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createServiceRequest } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { openRedCase } from '../helpers/actors.js';
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

describe('GET /api/v0/cases/:caseId/service-requests', () => {
  it('lists service requests for the veteran owner', async () => {
    const { pool, tenantId, veteran: user, headers, supportCase } = await openRedCase(app);
    const created = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'FOOD',
        details: {},
        createdBy: user.userId,
        actorType: 'VETERAN',
      }),
    );
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.service_requests).toEqual([
      {
        service_request_id: created.serviceRequestId,
        case_id: supportCase.caseId,
        category: 'FOOD',
        status: created.status,
      },
    ]);
  });

  it('hides another tenant case', async () => {
    const { supportCase } = await openRedCase(app);
    const stranger = await openRedCase(app);
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases/${supportCase.caseId}/service-requests`,
      headers: stranger.headers,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /api/v0/service-requests/:id', () => {
  it('returns one owned service request and 404s foreign ids', async () => {
    const { pool, tenantId, veteran: user, headers, supportCase } = await openRedCase(app);
    const created = await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: supportCase.caseId,
        category: 'TRANSPORTATION',
        details: {},
        createdBy: user.userId,
        actorType: 'VETERAN',
      }),
    );
    const ok = await app.server.inject({
      method: 'GET',
      url: `/api/v0/service-requests/${created.serviceRequestId}`,
      headers,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      service_request_id: created.serviceRequestId,
      category: 'TRANSPORTATION',
    });

    const other = await openRedCase(app);
    const leak = await app.server.inject({
      method: 'GET',
      url: `/api/v0/service-requests/${created.serviceRequestId}`,
      headers: other.headers,
    });
    expect(leak.statusCode).toBe(404);
  });
});
