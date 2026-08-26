/**
 * HTML POST wiring for released Slice 10 commands (requires PostgreSQL).
 *
 * SUAS-specs MVP_REFERENCE.md §7.2 (deploy / cancel / no second Deploy);
 * DISPATCH.md §4 (`CANCEL`); CASES.md §3 / §5; RESPONDER_WORKFLOWS.md §2;
 * API.md §4 (same session gate as the GET surfaces); AUTH.md §5.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { findActiveAssignment, findNonClosedCase } from '../../src/coordination/index.js';
import { createMembership, createOrganization, createUser } from '../../src/identity/index.js';
import { presentQrfState, VETERAN_QRF_CANCEL_REASON } from '../../src/ui/index.js';
import { readActiveQrf } from '../../src/ui/read.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }), listen: false });
});

afterAll(async () => {
  await app.close();
});

function pool() {
  const value = app.pool;
  if (value === undefined) throw new Error('The test app has no database pool.');
  return value;
}

function authorized(credential: string) {
  return { authorization: `Bearer ${credential}` };
}

async function veteranSession(): Promise<{
  credential: string;
  tenantId: string;
  userId: string;
}> {
  const tenantId = randomUUID();
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return { credential: session.credential, tenantId, userId: user.userId };
}

async function responderSession(tenantId: string): Promise<{
  credential: string;
  userId: string;
}> {
  const org = await createOrganization(pool(), {
    tenantId,
    name: `Org ${randomUUID().slice(0, 8)}`,
    status: 'ACTIVE',
  });
  const responder = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`resp-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await createMembership(pool(), {
    tenantId,
    organizationId: org.organizationId,
    userId: responder.userId,
    role: 'RESPONDER',
    status: 'ACTIVE',
  });
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: responder.userId,
  });
  return { credential: session.credential, userId: responder.userId };
}

async function countPeerSupport(tenantId: string): Promise<number> {
  const result = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM service_requests
      WHERE tenant_id = $1 AND category = 'PEER_SUPPORT'`,
    [tenantId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

describe('POST /app/qrf/deploy — veteran peer-support request', () => {
  it('refuses an unauthenticated deploy', async () => {
    const response = await app.server.inject({ method: 'POST', url: '/app/qrf/deploy' });
    expect(response.statusCode).toBe(401);
  });

  it('records one PEER_SUPPORT request and redirects to the home', async () => {
    const { credential, tenantId, userId } = await veteranSession();

    const response = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/app/home');
    expect(await countPeerSupport(tenantId)).toBe(1);

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Your QRF request');
    expect(home.body).toContain('REQUESTED');
    expect(home.body).not.toContain('Deploy QRF');
    expect(home.body).toContain('action="/app/qrf/cancel"');

    const supportCase = await findNonClosedCase(pool(), tenantId, userId);
    expect(supportCase).toBeDefined();
    const qrf = await readActiveQrf(pool(), tenantId, userId);
    expect(qrf?.serviceRequestId).toBeDefined();
  });

  it('is idempotent: a second deploy does not create another request', async () => {
    const { credential, tenantId } = await veteranSession();

    const first = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(credential),
    });
    const second = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(credential),
    });

    expect(first.statusCode).toBe(303);
    expect(second.statusCode).toBe(303);
    expect(await countPeerSupport(tenantId)).toBe(1);

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(home.body).not.toContain('Deploy QRF');
    expect(home.body).toContain('Your QRF request');
  });
});

describe('POST /app/qrf/cancel — veteran cancel', () => {
  it('refuses an unauthenticated cancel', async () => {
    const response = await app.server.inject({ method: 'POST', url: '/app/qrf/cancel' });
    expect(response.statusCode).toBe(401);
  });

  it('cancels the in-flight request and restores Deploy', async () => {
    const { credential, tenantId, userId } = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(credential),
    });

    const response = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/cancel',
      headers: authorized(credential),
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe('/app/home');
    expect(await readActiveQrf(pool(), tenantId, userId)).toBeUndefined();
    const reason = await pool().query<{ status_reason: string | null }>(
      `SELECT status_reason FROM service_requests
        WHERE tenant_id = $1 AND category = 'PEER_SUPPORT'`,
      [tenantId],
    );
    expect(reason.rows[0]?.status_reason).toBe(VETERAN_QRF_CANCEL_REASON);

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(home.body).toContain('Deploy QRF');
    expect(home.body).not.toContain('Your QRF request');
  });

  it('is idempotent: a second cancel still redirects home', async () => {
    const { credential, tenantId, userId } = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(credential),
    });
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/cancel',
      headers: authorized(credential),
    });

    const replay = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/cancel',
      headers: authorized(credential),
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe('/app/home');
    expect(await readActiveQrf(pool(), tenantId, userId)).toBeUndefined();
    expect(await countPeerSupport(tenantId)).toBe(1);
  });
});

describe('POST /app/responder/cases/:id/commands/claim — HTML claim', () => {
  it('refuses an unauthenticated claim', async () => {
    const response = await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${randomUUID()}/commands/claim`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('refuses a veteran without responder membership', async () => {
    const veteran = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(veteran.credential),
    });
    const supportCase = await findNonClosedCase(pool(), veteran.tenantId, veteran.userId);
    if (supportCase === undefined) throw new Error('expected a case after deploy');

    const response = await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${supportCase.caseId}/commands/claim`,
      headers: authorized(veteran.credential),
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets a responder claim and treats a same-responder replay as success', async () => {
    const veteran = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(veteran.credential),
    });
    const supportCase = await findNonClosedCase(pool(), veteran.tenantId, veteran.userId);
    if (supportCase === undefined) throw new Error('expected a case after deploy');
    const responder = await responderSession(veteran.tenantId);

    const claimed = await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${supportCase.caseId}/commands/claim`,
      headers: authorized(responder.credential),
    });
    expect(claimed.statusCode).toBe(303);
    expect(claimed.headers.location).toBe('/app/responder');

    const assignment = await findActiveAssignment(pool(), supportCase.caseId);
    expect(assignment?.responderUserId).toBe(responder.userId);

    const replay = await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${supportCase.caseId}/commands/claim`,
      headers: authorized(responder.credential),
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe('/app/responder');
  });
});

describe('MVP_REFERENCE.md §7.2 — RESPONDER_NOTIFIED on the home', () => {
  it('stays off RESPONDER_NOTIFIED when only an assignment exists', async () => {
    const veteran = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(veteran.credential),
    });
    const supportCase = await findNonClosedCase(pool(), veteran.tenantId, veteran.userId);
    if (supportCase === undefined) throw new Error('expected a case after deploy');
    const responder = await responderSession(veteran.tenantId);
    await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${supportCase.caseId}/commands/claim`,
      headers: authorized(responder.credential),
    });

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(veteran.credential),
    });
    expect(home.statusCode).toBe(200);
    expect(home.body).not.toContain('RESPONDER NOTIFIED');
    const qrf = await readActiveQrf(pool(), veteran.tenantId, veteran.userId);
    expect(qrf).toBeDefined();
    if (qrf === undefined) throw new Error('expected an in-flight request');
    expect(presentQrfState(qrf.facts).state).not.toBe('RESPONDER_NOTIFIED');
  });

  it('renders RESPONDER_NOTIFIED only with a subject-linked delivery', async () => {
    const veteran = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(veteran.credential),
    });
    const supportCase = await findNonClosedCase(pool(), veteran.tenantId, veteran.userId);
    if (supportCase === undefined) throw new Error('expected a case after deploy');
    const responder = await responderSession(veteran.tenantId);
    await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${supportCase.caseId}/commands/claim`,
      headers: authorized(responder.credential),
    });
    const qrf = await readActiveQrf(pool(), veteran.tenantId, veteran.userId);
    if (qrf === undefined) throw new Error('expected an in-flight request');

    await pool().query(
      `INSERT INTO notifications
         (notification_id, tenant_id, recipient_user_id, reason, channel, consent_basis,
          template_version, subject_type, subject_id, delivery_status)
       VALUES ($1, $2, $3, 'qrf.responder_notified', 'IN_APP', 'RESPONDER_CASE_ASSIGNMENT',
               'test@1', 'ServiceRequest', $4, 'SENT')`,
      [randomUUID(), veteran.tenantId, responder.userId, qrf.serviceRequestId],
    );

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(veteran.credential),
    });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('RESPONDER NOTIFIED');
    expect(home.body).toContain('A responder has been notified.');
  });

  it('does not treat a notification without a Service Request subject as delivery', async () => {
    const veteran = await veteranSession();
    await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: authorized(veteran.credential),
    });
    const supportCase = await findNonClosedCase(pool(), veteran.tenantId, veteran.userId);
    if (supportCase === undefined) throw new Error('expected a case after deploy');
    const responder = await responderSession(veteran.tenantId);
    await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${supportCase.caseId}/commands/claim`,
      headers: authorized(responder.credential),
    });

    await pool().query(
      `INSERT INTO notifications
         (notification_id, tenant_id, recipient_user_id, reason, channel, consent_basis,
          template_version, delivery_status)
       VALUES ($1, $2, $3, 'qrf.responder_notified', 'IN_APP', 'RESPONDER_CASE_ASSIGNMENT',
               'test@1', 'SENT')`,
      [randomUUID(), veteran.tenantId, responder.userId],
    );

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(veteran.credential),
    });
    expect(home.body).not.toContain('RESPONDER NOTIFIED');
  });
});
