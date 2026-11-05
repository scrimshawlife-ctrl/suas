/**
 * Test shortcut for "a helper holds this Support Case".
 *
 * Accepting is per Service Request (decided 2026-11-05), so a case is held through a
 * request. Tests that only need a held case, to exercise case commands, contact logs,
 * settlement and the like, use this instead of building a full request flow. It adds one
 * already-cancelled request accepted by the helper (terminal, so it never blocks a resolve and
 * is not counted as a requester confirmation) and
 * moves an `OPEN` or `TRIAGED` case to `ASSIGNED` exactly as an accept does.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../src/db/index.js';
import {
  acceptRequestInTx,
  executeServiceRequestCommandInTx,
  findServiceRequest,
  lockCase,
  recordRequestAcceptedOnCase,
  ServiceRequestNotFoundError,
  type ServiceRequest,
  type SupportCase,
} from '../../src/coordination/index.js';

export async function holdCase(
  pool: Pool,
  input: { tenantId: string; caseId: string; acceptedByUserId: string },
): Promise<SupportCase> {
  return withTransaction(pool, async (tx) => {
    const supportCase = await lockCase(tx, input.tenantId, input.caseId);
    const serviceRequestId = randomUUID();
    await tx.query(
      `INSERT INTO service_requests
         (service_request_id, tenant_id, case_id, category, status, created_by,
          accepted_by_user_id, terminal_at)
       VALUES ($1, $2, $3, 'PEER_SUPPORT', 'CANCELLED', $4, $5, now())`,
      [
        serviceRequestId,
        input.tenantId,
        input.caseId,
        supportCase.veteranUserId,
        input.acceptedByUserId,
      ],
    );
    return recordRequestAcceptedOnCase(tx, {
      tenantId: input.tenantId,
      supportCase,
      serviceRequestId,
      acceptedByUserId: input.acceptedByUserId,
    });
  });
}

/**
 * A helper accepts one existing request: it is submitted first if it is still `CREATED`,
 * then the accept writes run as the HTTP accept does (holder, `ACCEPTED`, case, chat
 * thread), without the county check.
 */
export async function holdRequest(
  pool: Pool,
  input: { tenantId: string; serviceRequestId: string; acceptedByUserId: string },
): Promise<ServiceRequest> {
  return withTransaction(pool, async (tx) => {
    const request = await findServiceRequest(tx, input.tenantId, input.serviceRequestId);
    if (request === undefined) throw new ServiceRequestNotFoundError();
    const supportCase = await lockCase(tx, input.tenantId, request.caseId);
    if (request.status === 'CREATED') {
      await executeServiceRequestCommandInTx(tx, {
        tenantId: input.tenantId,
        serviceRequestId: input.serviceRequestId,
        command: 'SUBMIT',
        actorId: supportCase.veteranUserId,
        actorType: 'VETERAN',
      });
    }
    const accepted = await acceptRequestInTx(tx, {
      tenantId: input.tenantId,
      supportCase,
      serviceRequestId: input.serviceRequestId,
      acceptedByUserId: input.acceptedByUserId,
    });
    return accepted.serviceRequest;
  });
}
