/**
 * QRF read evidence for the RESPONDER_NOTIFIED linkage (requires PostgreSQL).
 *
 * SUAS-specs MVP_REFERENCE.md §7.2: RESPONDER_NOTIFIED is permitted only when the
 * system can see a delivery linked to the request; an assignment alone stays
 * SEARCHING. Accepted gap proposal P-12 (docs/SPEC_GAP_PROPOSALS.md; Slice 10 §10
 * item 1) added the notification subject reference this read depends on.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { createServiceRequest, openCase } from '../../src/coordination/index.js';
import { createUser } from '../../src/identity/index.js';
import { readActiveQrf } from '../../src/ui/read.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { holdRequest } from '../helpers/hold-case.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function activeUser(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

/** A veteran with an in-flight PEER_SUPPORT request claimed by a responder. */
async function assignedQrf() {
  const tenantId = syntheticTenantId();
  const veteran = await activeUser(tenantId, 'veteran');
  const responder = await activeUser(tenantId, 'responder');
  const opened = await withTransaction(pool, (tx) =>
    openCase(tx, {
      tenantId,
      veteranUserId: veteran.userId,
      actorType: 'VETERAN',
      actorId: veteran.userId,
    }),
  );
  const request = await withTransaction(pool, (tx) =>
    createServiceRequest(tx, {
      tenantId,
      caseId: opened.supportCase.caseId,
      category: 'PEER_SUPPORT',
      createdBy: veteran.userId,
      actorType: 'VETERAN',
    }),
  );
  await holdRequest(pool, {
    tenantId,
    serviceRequestId: request.serviceRequestId,
    acceptedByUserId: responder.userId,
  });
  return { tenantId, veteran, responder, request };
}

describe('MVP_REFERENCE.md §7.2 — RESPONDER_NOTIFIED requires a recorded delivery', () => {
  it('stays SEARCHING with an active assignment but no delivered notification', async () => {
    const { tenantId, veteran, request } = await assignedQrf();

    const qrf = await readActiveQrf(pool, tenantId, veteran.userId);
    expect(qrf?.serviceRequestId).toBe(request.serviceRequestId);
    expect(qrf?.facts.assigned).toBe(true);
    expect(qrf?.facts.assignedNotificationDelivered).toBe(false);
  });

  it('reports the delivery once a notification to the responder is linked to the request', async () => {
    const { tenantId, veteran, responder, request } = await assignedQrf();

    // A notification about this request, addressed to the active responder, that
    // reached a sent state — the exact fact §7.2 requires. Inserted directly to
    // isolate the read join from the full send pipeline.
    await pool.query(
      `INSERT INTO notifications
         (notification_id, tenant_id, recipient_user_id, reason, channel, consent_basis,
          template_version, subject_type, subject_id, delivery_status)
       VALUES ($1, $2, $3, 'qrf.responder_notified', 'IN_APP', 'CASE_ASSIGNMENT',
               'test@1', 'ServiceRequest', $4, 'SENT')`,
      [randomUUID(), tenantId, responder.userId, request.serviceRequestId],
    );

    const qrf = await readActiveQrf(pool, tenantId, veteran.userId);
    expect(qrf?.facts.assignedNotificationDelivered).toBe(true);
  });

  it('does not count a notification to someone other than the active responder', async () => {
    const { tenantId, veteran, request } = await assignedQrf();
    const bystander = await activeUser(tenantId, 'bystander');

    await pool.query(
      `INSERT INTO notifications
         (notification_id, tenant_id, recipient_user_id, reason, channel, consent_basis,
          template_version, subject_type, subject_id, delivery_status)
       VALUES ($1, $2, $3, 'qrf.responder_notified', 'IN_APP', 'CASE_ASSIGNMENT',
               'test@1', 'ServiceRequest', $4, 'SENT')`,
      [randomUUID(), tenantId, bystander.userId, request.serviceRequestId],
    );

    const qrf = await readActiveQrf(pool, tenantId, veteran.userId);
    expect(qrf?.facts.assignedNotificationDelivered).toBe(false);
  });
});

describe('the in-flight request covers every category', () => {
  async function requestOf(
    tenantId: string,
    veteranId: string,
    category: 'FOOD' | 'TRANSPORTATION' | 'SHELTER' | 'PEER_SUPPORT',
  ) {
    const opened = await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteranId,
        actorType: 'VETERAN',
        actorId: veteranId,
      }),
    );
    return withTransaction(pool, (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: opened.supportCase.caseId,
        category,
        createdBy: veteranId,
        actorType: 'VETERAN',
        details: { meeting_place: 'Main Street library' },
      }),
    );
  }

  it.each(['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'] as const)(
    'reads an open %s request',
    async (category) => {
      const tenantId = syntheticTenantId();
      const veteran = await activeUser(tenantId, 'veteran');
      const request = await requestOf(tenantId, veteran.userId, category);

      const qrf = await readActiveQrf(pool, tenantId, veteran.userId);
      expect(qrf?.serviceRequestId).toBe(request.serviceRequestId);
    },
  );

  it('returns the newest open request, and can be narrowed to one category', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await activeUser(tenantId, 'veteran');
    const peer = await requestOf(tenantId, veteran.userId, 'PEER_SUPPORT');
    const food = await requestOf(tenantId, veteran.userId, 'FOOD');

    expect((await readActiveQrf(pool, tenantId, veteran.userId))?.serviceRequestId).toBe(
      food.serviceRequestId,
    );
    expect(
      (await readActiveQrf(pool, tenantId, veteran.userId, { category: 'PEER_SUPPORT' }))
        ?.serviceRequestId,
    ).toBe(peer.serviceRequestId);
  });

  it('reads accepted from the request itself, not from another request on the case', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await activeUser(tenantId, 'veteran');
    const responder = await activeUser(tenantId, 'responder');
    const first = await requestOf(tenantId, veteran.userId, 'FOOD');
    await holdRequest(pool, {
      tenantId,
      serviceRequestId: first.serviceRequestId,
      acceptedByUserId: responder.userId,
    });
    const second = await requestOf(tenantId, veteran.userId, 'SHELTER');

    const qrf = await readActiveQrf(pool, tenantId, veteran.userId);
    expect(qrf?.serviceRequestId).toBe(second.serviceRequestId);
    expect(qrf?.facts.assigned).toBe(false);
  });
});
