/**
 * Accepting a Service Request.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Peer flow": any signed-in person can accept; one person
 *   per request, first accept wins, and the request leaves other people's lists. A
 *   requester cannot accept their own request. Decided 2026-11-05: a helper holds the
 *   one request they accept, not the Veteran's whole Support Case, so a Veteran's later
 *   request is open to a different helper.
 * - SUAS-specs CASES.md §5 (atomic claim under a row lock).
 *
 * The case row is locked first (the order widening uses), then the request row, so "is
 * this open to me?" and "did someone else win?" are one decision. They run in this
 * order: (1) may this person see the request at all (own request, county, widening)? If
 * not, it reads as not found, the same as a list they never see it in. (2) has someone
 * else already accepted this request? Only a person who passed (1) learns that (409), so
 * the answer never reveals a request the caller could not see. (3) is it still in an open
 * state (not cancelled, not already past matching)? On success the holder is recorded on
 * the request, the chat thread is created and the request moves to `ACCEPTED`, all in
 * one transaction. A first accept on an `OPEN` case also moves the case to `ASSIGNED`.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/transaction.js';
import { lockCase, recordRequestAcceptedOnCase, type SupportCase } from './cases.js';
import { createChatThreadInTx } from './chat-threads.js';
import {
  CountyRequiredError,
  findUserCounty,
  OPEN_REQUEST_STATE_CONDITIONS,
  REQUEST_REQUESTER_FROM,
  visibleToViewerConditions,
} from './open-requests.js';
import {
  findServiceRequest,
  peerAcceptRequestInTx,
  ServiceRequestNotFoundError,
  type ServiceRequest,
} from './requests.js';

/** A requester tried to accept their own request. */
export class OwnRequestError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('You cannot accept your own request.');
    this.name = 'OwnRequestError';
  }
}

/** First accept wins: someone else already holds this request. */
export class RequestAlreadyAcceptedError extends Error {
  readonly code = 'ALREADY_CLAIMED';
  readonly httpStatus = 409;

  constructor() {
    super('Someone else has already accepted this request.');
    this.name = 'RequestAlreadyAcceptedError';
  }
}

export interface AcceptServiceRequestInput {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly acceptedByUserId: string;
  readonly correlationId?: string;
}

export interface AcceptServiceRequestResult {
  readonly supportCase: SupportCase;
  readonly serviceRequest: ServiceRequest;
}

export async function acceptServiceRequest(
  pool: Pool,
  input: AcceptServiceRequestInput,
): Promise<AcceptServiceRequestResult> {
  const request = await findServiceRequest(pool, input.tenantId, input.serviceRequestId);
  if (request === undefined) throw new ServiceRequestNotFoundError();

  return withTransaction(pool, async (tx) => {
    const supportCase = await lockCase(tx, input.tenantId, request.caseId);

    // Locks the request too, so a requester cancelling it and an accept serialize.
    const locked = await tx.query<{ accepted_by_user_id: string | null }>(
      `SELECT accepted_by_user_id FROM service_requests
        WHERE tenant_id = $1 AND service_request_id = $2
        FOR UPDATE`,
      [input.tenantId, input.serviceRequestId],
    );
    const holder = locked.rows[0]?.accepted_by_user_id;
    if (locked.rows[0] === undefined) throw new ServiceRequestNotFoundError();

    // A replay by the person who already holds it returns the same answer and writes nothing.
    if (holder === input.acceptedByUserId) {
      const held = await findServiceRequest(tx, input.tenantId, input.serviceRequestId);
      if (held === undefined) throw new ServiceRequestNotFoundError();
      return { supportCase, serviceRequest: held };
    }

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

    if (holder !== null && holder !== undefined) throw new RequestAlreadyAcceptedError();

    const open = await tx.query(
      `SELECT 1
         FROM ${REQUEST_REQUESTER_FROM}
        WHERE r.tenant_id = $1 AND r.service_request_id = $2
          AND ${OPEN_REQUEST_STATE_CONDITIONS.join(' AND ')}`,
      [input.tenantId, input.serviceRequestId],
    );
    if ((open.rowCount ?? 0) === 0) throw new ServiceRequestNotFoundError();

    return acceptRequestInTx(tx, {
      tenantId: input.tenantId,
      supportCase,
      serviceRequestId: input.serviceRequestId,
      acceptedByUserId: input.acceptedByUserId,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  });
}

/**
 * The writes of an accept, after every guard has passed: the holder and `ACCEPTED` on the
 * request, `ASSIGNED` on a first-accept `OPEN` case, and the chat thread. The caller holds
 * the case row lock and has checked eligibility; `acceptServiceRequest` is the HTTP path,
 * and the local seed uses this directly because it has no county to check.
 */
export async function acceptRequestInTx(
  tx: PoolClient,
  input: {
    readonly tenantId: string;
    readonly supportCase: SupportCase;
    readonly serviceRequestId: string;
    readonly acceptedByUserId: string;
    readonly correlationId?: string;
  },
): Promise<AcceptServiceRequestResult> {
  const serviceRequest = await peerAcceptRequestInTx(tx, {
    tenantId: input.tenantId,
    serviceRequestId: input.serviceRequestId,
    actorId: input.acceptedByUserId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
  const supportCase = await recordRequestAcceptedOnCase(tx, {
    tenantId: input.tenantId,
    supportCase: input.supportCase,
    serviceRequestId: input.serviceRequestId,
    acceptedByUserId: input.acceptedByUserId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
  await createChatThreadInTx(tx, {
    tenantId: input.tenantId,
    serviceRequestId: input.serviceRequestId,
    requesterUserId: input.supportCase.veteranUserId,
    acceptedByUserId: input.acceptedByUserId,
  });
  return { supportCase, serviceRequest };
}
