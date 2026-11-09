/**
 * Requester edit of a waiting Service Request (V1_MVP_PROPOSAL.md R8.1, R8.7).
 *
 * Summary, timing, meeting place and destination change in place while nobody has accepted
 * the request. Category never changes. Locks the case row, then the request row, the same
 * order accept uses, so an edit and an accept serialize. The Audit Event carries ids only:
 * the edited text never goes into an event, log or stored command result.
 */

import type { PoolClient } from 'pg';
import { appendAuditEvent } from '../events/index.js';
import type { JsonObject } from '../jobs/index.js';
import { lockCase } from './cases.js';
import { StaleRequestStateError, type ServiceRequestStatus } from './request-transitions.js';
import {
  assertDestinationAllowed,
  findServiceRequest,
  MeetingPlaceRequiredError,
  requiresMeetingPlace,
  ServiceRequestNotFoundError,
  type ServiceRequest,
} from './requests.js';

/** Statuses where a request is still waiting for someone to accept it. */
const EDITABLE_STATUSES: readonly ServiceRequestStatus[] = ['SUBMITTED', 'TRIAGED', 'MATCHING'];

/** `null` clears a field; an absent key leaves it as it is. */
export interface RequestEditChanges {
  readonly summary?: string;
  readonly timing?: string | null;
  readonly meetingPlace?: string | null;
  readonly destination?: string | null;
}

export class RequestNotEditableError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor() {
    super('This request can no longer be edited: someone accepted it or it is closed.');
    this.name = 'RequestNotEditableError';
  }
}

const DETAIL_KEYS = {
  summary: 'summary',
  timing: 'timing',
  meetingPlace: 'meeting_place',
  destination: 'destination',
} as const satisfies Record<keyof RequestEditChanges, string>;

function applyChanges(details: JsonObject, changes: RequestEditChanges): JsonObject {
  const next: JsonObject = { ...details };
  for (const field of Object.keys(DETAIL_KEYS) as (keyof RequestEditChanges)[]) {
    const value = changes[field];
    if (value === undefined) continue;
    if (value === null) delete next[DETAIL_KEYS[field]];
    else next[DETAIL_KEYS[field]] = value;
  }
  return next;
}

export async function editServiceRequestInTx(
  tx: PoolClient,
  input: {
    readonly tenantId: string;
    readonly serviceRequestId: string;
    readonly actorId: string;
    readonly changes: RequestEditChanges;
    readonly expectedStatus?: ServiceRequestStatus;
    readonly correlationId?: string;
  },
): Promise<ServiceRequest> {
  const found = await findServiceRequest(tx, input.tenantId, input.serviceRequestId);
  if (found === undefined) throw new ServiceRequestNotFoundError();
  await lockCase(tx, input.tenantId, found.caseId);
  await tx.query(
    `SELECT 1 FROM service_requests
      WHERE tenant_id = $1 AND service_request_id = $2
      FOR UPDATE`,
    [input.tenantId, input.serviceRequestId],
  );

  // Read again under the lock: the status and holder above may have just changed.
  const current = await findServiceRequest(tx, input.tenantId, input.serviceRequestId);
  if (current === undefined) throw new ServiceRequestNotFoundError();
  if (input.expectedStatus !== undefined && current.status !== input.expectedStatus) {
    throw new StaleRequestStateError(input.expectedStatus, current.status);
  }
  if (current.acceptedByUserId !== undefined || !EDITABLE_STATUSES.includes(current.status)) {
    throw new RequestNotEditableError();
  }

  assertDestinationAllowed(current.category, input.changes.destination);
  if (input.changes.meetingPlace === null && requiresMeetingPlace(current.category)) {
    throw new MeetingPlaceRequiredError();
  }

  const details = applyChanges(current.details, input.changes);
  await tx.query(
    `UPDATE service_requests SET details = $3::jsonb, updated_at = now()
      WHERE tenant_id = $1 AND service_request_id = $2`,
    [input.tenantId, input.serviceRequestId, JSON.stringify(details)],
  );

  await appendAuditEvent(tx, {
    eventType: 'SERVICE_REQUEST_EDITED',
    action: 'EDIT_SERVICE_REQUEST',
    targetType: 'ServiceRequest',
    targetId: input.serviceRequestId,
    aggregateType: 'ServiceRequest',
    aggregateId: input.serviceRequestId,
    tenantId: input.tenantId,
    actorType: 'VETERAN',
    actorId: input.actorId,
    payload: { case_id: current.caseId, category: current.category },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return { ...current, details };
}
