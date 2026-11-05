/**
 * Accepting a Service Request.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Peer flow": any signed-in person can accept; one person
 *   per request, first accept wins, and the request leaves other people's lists. A
 *   requester cannot accept their own request.
 * - SUAS-specs CASES.md §5 (atomic claim under a row lock).
 *
 * Accepting is `claimCase` on the request's Support Case. The checks run inside the
 * case row lock, so "is this open to me?" and "did someone else win?" are one decision.
 * They run in this order: (1) may this person see the request at all (own request,
 * county, widening)? If not, it reads as not found, the same as a list they never see it
 * in. (2) has someone else already accepted it? Only a person who passed (1) learns that
 * (409), so the answer never reveals a request the caller could not see. (3) is it still
 * in an open state (not cancelled, not already past matching)?
 */

import type { Pool } from 'pg';
import { claimCase, type AssignmentResult } from './cases.js';
import { createChatThreadInTx } from './chat-threads.js';
import {
  CountyRequiredError,
  findUserCounty,
  OPEN_REQUEST_STATE_CONDITIONS,
  REQUEST_REQUESTER_FROM,
  visibleToViewerConditions,
} from './open-requests.js';
import { findServiceRequest, ServiceRequestNotFoundError } from './requests.js';

/** A requester tried to accept their own request. */
export class OwnRequestError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('You cannot accept your own request.');
    this.name = 'OwnRequestError';
  }
}

export interface AcceptServiceRequestInput {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly acceptedByUserId: string;
  readonly correlationId?: string;
}

export async function acceptServiceRequest(
  pool: Pool,
  input: AcceptServiceRequestInput,
): Promise<AssignmentResult> {
  const request = await findServiceRequest(pool, input.tenantId, input.serviceRequestId);
  if (request === undefined) throw new ServiceRequestNotFoundError();

  return claimCase(pool, {
    tenantId: input.tenantId,
    caseId: request.caseId,
    acceptedByUserId: input.acceptedByUserId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    afterClaim: async (tx, result) => {
      await createChatThreadInTx(tx, {
        tenantId: input.tenantId,
        serviceRequestId: input.serviceRequestId,
        requesterUserId: result.supportCase.veteranUserId,
        acceptedByUserId: input.acceptedByUserId,
      });
    },
    visibilityGuard: async (tx, supportCase) => {
      if (supportCase.veteranUserId === input.acceptedByUserId) throw new OwnRequestError();

      const county = await findUserCounty(tx, input.tenantId, input.acceptedByUserId);
      if (county === undefined) throw new CountyRequiredError();

      const visible = await tx.query(
        `SELECT 1
           FROM ${REQUEST_REQUESTER_FROM}
          WHERE r.tenant_id = $1 AND r.service_request_id = $2
            AND ${visibleToViewerConditions('$3', '$4').join(' AND ')}`,
        [input.tenantId, input.serviceRequestId, input.acceptedByUserId, county],
      );
      if ((visible.rowCount ?? 0) === 0) throw new ServiceRequestNotFoundError();
    },
    guard: async (tx) => {
      // FOR UPDATE OF r serializes with a requester cancelling the same request.
      const open = await tx.query(
        `SELECT 1
           FROM ${REQUEST_REQUESTER_FROM}
          WHERE r.tenant_id = $1 AND r.service_request_id = $2
            AND ${OPEN_REQUEST_STATE_CONDITIONS.join(' AND ')}
          FOR UPDATE OF r`,
        [input.tenantId, input.serviceRequestId],
      );
      if ((open.rowCount ?? 0) === 0) throw new ServiceRequestNotFoundError();
    },
  });
}
