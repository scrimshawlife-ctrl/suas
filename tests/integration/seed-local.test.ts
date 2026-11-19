/**
 * `npm run seed` can be run again on a seeded LOCAL database (requires PostgreSQL).
 *
 * The seed is status-driven. It must converge, not fail, when the database already holds
 * its data, and when someone has used the app on a seeded account in between.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { runLocalSeed } from '../../src/cli/seed-local.js';
import { createServiceRequest, openCase } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

const pool: Pool = createTestPool();
let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl() }),
    listen: false,
  });
});
beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await app.close();
  await resetKernelTables(pool);
  await pool.end();
});

describe('runLocalSeed', () => {
  it('converges when run twice', async () => {
    const first = await runLocalSeed(pool);
    const second = await runLocalSeed(pool);

    expect(second.qrf.serviceRequestId).toBe(first.qrf.serviceRequestId);
    expect(second.settled).toMatchObject({ status: 'CLOSED', caseId: first.settled.caseId });
    expect(first.settled.status).toBe('CLOSED');
  });

  it("leaves a seeded account's own later request alone", async () => {
    const first = await runLocalSeed(pool);
    // The seeded Veteran with the settled case asks for help: a new current case with a live request.
    const opened = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId: first.admin.tenantId,
        veteranUserId: first.veteranTwo.userId,
        actorType: 'VETERAN',
        actorId: first.veteranTwo.userId,
      }),
    );
    expect(opened.supportCase.caseId).not.toBe(first.settled.caseId);
    await withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId: first.admin.tenantId,
        caseId: opened.supportCase.caseId,
        category: 'FOOD',
        createdBy: first.veteranTwo.userId,
        actorType: 'VETERAN',
        details: { meeting_place: 'Main Street library' },
      }),
    );

    const again = await runLocalSeed(pool);

    expect(again.settled).toMatchObject({ caseId: first.settled.caseId, status: 'CLOSED' });
    const cases = await pool.query(`SELECT 1 FROM support_cases WHERE veteran_user_id = $1`, [
      first.veteranTwo.userId,
    ]);
    expect(cases.rowCount).toBe(2);
  });

  it('leaves the demo Veteran unverified, so the gate holds until they self-attest', async () => {
    // seed:demo seeds its Veteran through runLocalSeed with this local part and writes no
    // Veteran verification, so a fresh demo dataset starts behind the R9.1 gate.
    const { veteran } = await runLocalSeed(pool, { veteranLocalPart: 'demo' });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId: veteran.tenantId,
      userId: veteran.userId,
    });
    const headers = { authorization: `Bearer ${session.credential}` };
    const resources = () => app.server.inject({ method: 'GET', url: '/api/v0/resources', headers });

    const gated = await resources();
    expect(gated.statusCode).toBe(403);
    expect(gated.json<{ error: { code: string } }>().error.code).toBe('VERIFICATION_REQUIRED');

    const attested = await app.server.inject({
      method: 'POST',
      url: '/api/v0/veterans/me/verification/commands/self-attest',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: {},
    });
    expect(attested.statusCode).toBe(200);
    expect((await resources()).statusCode).toBe(200);
  });
});
