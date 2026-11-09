/**
 * Service Request commands.
 *
 * Spec citations:
 * - SUAS-specs DISPATCH.md §1 (a Service Request is not a Case), §3 (command
 *   concurrency invariant), §4 (transitions), §5 (provider relationship),
 *   §6 (assignment concurrency), §7 (categories), §8 (consent/privacy)
 * - SUAS-specs EVENT_MODEL.md §3 (`SERVICE_REQUEST_CREATED`,
 *   `SERVICE_REQUEST_ASSIGNED`)
 * - SUAS-specs CONSENT.md §3.8, §3.10-§3.11 (consent is evaluated before each
 *   external mutation that newly discloses data; reroute re-evaluates)
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent, appendDomainEvent } from '../events/index.js';
import type { JsonObject } from '../jobs/index.js';
import { findCase, CaseNotFoundError } from './cases.js';
import {
  assertServiceCategory,
  resolveRequestTransition,
  StaleRequestStateError,
  TERMINAL_REQUEST_STATUSES,
  type ServiceCategory,
  type ServiceRequestCommand,
  type ServiceRequestStatus,
} from './request-transitions.js';

export interface ServiceRequest {
  readonly serviceRequestId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly category: ServiceCategory;
  readonly status: ServiceRequestStatus;
  readonly details: JsonObject;
  /** The user who created the request (DISPATCH.md §4 "creator"). */
  readonly createdBy: string;
  /** The helper who accepted this request; undefined until someone does. Set once. */
  readonly acceptedByUserId: string | undefined;
}

interface RequestRow {
  service_request_id: string;
  tenant_id: string;
  case_id: string;
  category: ServiceCategory;
  status: ServiceRequestStatus;
  details: JsonObject;
  created_by: string;
  accepted_by_user_id: string | null;
}

const REQUEST_COLUMNS =
  'service_request_id, tenant_id, case_id, category, status, details, created_by, accepted_by_user_id';

function toRequest(row: RequestRow): ServiceRequest {
  return {
    serviceRequestId: row.service_request_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    category: row.category,
    status: row.status,
    details: row.details,
    createdBy: row.created_by,
    acceptedByUserId: row.accepted_by_user_id ?? undefined,
  };
}

export class ServiceRequestNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'ServiceRequestNotFoundError';
  }
}

/** Longest meeting place a request may carry. */
export const MEETING_PLACE_MAX = 200;

/** Categories where the helper must know where to meet, so submit refuses without one. */
const MEETING_PLACE_REQUIRED: readonly ServiceCategory[] = ['TRANSPORTATION', 'FOOD', 'SHELTER'];

/**
 * A free-text field of `details` that is present, a string, and within bounds, else null.
 * `meeting_place` is sensitive free text: it is read here and returned to the
 * request's owner and accepter only. It never goes in a log, event or audit payload.
 */
export function readDetailText(details: JsonObject, key: string, max: number): string | null {
  const value = details[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' || trimmed.length > max ? null : trimmed;
}

export class MeetingPlaceRequiredError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super('Say where to meet (meeting_place) before submitting this kind of request.');
    this.name = 'MeetingPlaceRequiredError';
  }
}

export class ClosedCaseError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super('A Service Request cannot be created on a closed Case (SUAS-specs DISPATCH.md §4).');
    this.name = 'ClosedCaseError';
  }
}

export interface CreateServiceRequestInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly category: string;
  readonly createdBy: string;
  readonly actorType: 'VETERAN' | 'USER';
  readonly details?: JsonObject;
  readonly correlationId?: string;
}

/**
 * Create a Service Request under an open Case.
 *
 * DISPATCH.md §4 requires the parent Case to exist and not be `CLOSED`, and
 * §7 rejects unknown category codes — including the reserved future ones.
 */
export async function createServiceRequest(
  tx: PoolClient,
  input: CreateServiceRequestInput,
): Promise<ServiceRequest> {
  assertServiceCategory(input.category);

  const parent = await findCase(tx, input.tenantId, input.caseId);
  if (parent === undefined) throw new CaseNotFoundError();
  if (parent.status === 'CLOSED') throw new ClosedCaseError();

  const serviceRequestId = randomUUID();
  const result = await tx.query<RequestRow>(
    `INSERT INTO service_requests
       (service_request_id, tenant_id, case_id, category, details, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${REQUEST_COLUMNS}`,
    [
      serviceRequestId,
      input.tenantId,
      input.caseId,
      input.category,
      JSON.stringify(input.details ?? {}),
      input.createdBy,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Service request insert returned no row.');

  await appendDomainEvent(tx, {
    eventType: 'SERVICE_REQUEST_CREATED',
    aggregateType: 'ServiceRequest',
    aggregateId: serviceRequestId,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.createdBy,
    payload: { case_id: input.caseId, category: input.category },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return toRequest(row);
}

export async function findServiceRequest(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
): Promise<ServiceRequest | undefined> {
  const result = await db.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests
     WHERE tenant_id = $1 AND service_request_id = $2`,
    [tenantId, serviceRequestId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toRequest(row);
}

/**
 * Evaluated before an `ASSIGN` that puts veteran data in front of a third party.
 *
 * DISPATCH.md §8 and CONSENT.md §3.8: the basis is evaluated at call time, and
 * §3.10-§3.11 make a reroute a fresh disclosure decision rather than a reuse of
 * the previous one.
 */
export type DisclosureGuard = (params: {
  tenantId: string;
  serviceRequestId: string;
  caseId: string;
  granteeId: string;
}) => Promise<void>;

export interface ServiceRequestCommandInput {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly command: ServiceRequestCommand;
  readonly actorId: string;
  readonly actorType: 'VETERAN' | 'USER' | 'SERVICE_PROVIDER' | 'SYSTEM';
  readonly reason?: string;
  /** Required when the command has more than one documented target. */
  readonly to?: ServiceRequestStatus;
  readonly expectedStatus?: ServiceRequestStatus;
  /** Grantee receiving the disclosure, for an externally disclosing edge. */
  readonly granteeId?: string;
  readonly correlationId?: string;
}

export class DisclosureGuardRequiredError extends Error {
  readonly code = 'CONSENT_DENIED';
  readonly httpStatus = 403;

  constructor() {
    super(
      'This transition discloses veteran data outside SUAS and no consent evaluation was ' +
        'supplied, so it is refused (SUAS-specs DISPATCH.md §8; CONSENT.md §3.8).',
    );
    this.name = 'DisclosureGuardRequiredError';
  }
}

/**
 * Execute a documented Service Request transition inside an existing transaction.
 * Prefer {@link executeServiceRequestCommand} unless the caller already owns a tx
 * (for example HTTP idempotency wrapping).
 */
export async function executeServiceRequestCommandInTx(
  tx: Queryable,
  input: ServiceRequestCommandInput,
  deps: { disclosureGuard?: DisclosureGuard } = {},
): Promise<ServiceRequest> {
  const locked = await tx.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests
     WHERE tenant_id = $1 AND service_request_id = $2
     FOR UPDATE`,
    [input.tenantId, input.serviceRequestId],
  );
  const row = locked.rows[0];
  if (row === undefined) throw new ServiceRequestNotFoundError();
  const request = toRequest(row);

  if (input.expectedStatus !== undefined && request.status !== input.expectedStatus) {
    throw new StaleRequestStateError(input.expectedStatus, request.status);
  }

  const transition = resolveRequestTransition(input.command, request.status, {
    ...(input.to !== undefined ? { to: input.to } : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  // Submitting puts the request on the helper list, so it needs a meeting place first.
  if (
    input.command === 'SUBMIT' &&
    MEETING_PLACE_REQUIRED.includes(request.category) &&
    readDetailText(request.details, 'meeting_place', MEETING_PLACE_MAX) === null
  ) {
    throw new MeetingPlaceRequiredError();
  }

  // CONSENT.md §3.10: evaluated before the mutation commits, every time — a
  // previous assignment never carries authority forward to a new one.
  if (transition.mayDiscloseExternally) {
    if (deps.disclosureGuard === undefined) {
      throw new DisclosureGuardRequiredError();
    }
    await deps.disclosureGuard({
      tenantId: input.tenantId,
      serviceRequestId: input.serviceRequestId,
      caseId: request.caseId,
      granteeId: input.granteeId ?? 'unspecified',
    });
  }

  // One terminal list for the state machine and the helper counts (DISPATCH.md §4).
  const terminal = TERMINAL_REQUEST_STATUSES.includes(transition.to);
  const updated = await tx.query<RequestRow>(
    `UPDATE service_requests
       SET status = $3::suas_service_request_status,
           updated_at = now(),
           status_reason = COALESCE($4, status_reason),
           submitted_at = CASE WHEN $3::text = 'SUBMITTED' THEN now() ELSE submitted_at END,
           terminal_at = CASE WHEN $5::boolean THEN now() ELSE terminal_at END
     WHERE tenant_id = $1 AND service_request_id = $2
     RETURNING ${REQUEST_COLUMNS}`,
    [input.tenantId, input.serviceRequestId, transition.to, input.reason ?? null, terminal],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow === undefined) throw new ServiceRequestNotFoundError();

  if (input.command === 'ASSIGN') {
    await appendDomainEvent(tx, {
      eventType: 'SERVICE_REQUEST_ASSIGNED',
      aggregateType: 'ServiceRequest',
      aggregateId: input.serviceRequestId,
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorId: input.actorId,
      payload: {
        case_id: request.caseId,
        category: request.category,
        ...(input.granteeId !== undefined ? { grantee_id: input.granteeId } : {}),
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  }

  return toRequest(updatedRow);
}

/** Statuses in which a Service Request is still waiting for someone to accept it. */
const PEER_ACCEPTABLE: readonly ServiceRequestStatus[] = ['SUBMITTED', 'TRIAGED', 'MATCHING'];

/**
 * Peer accept: the one transition that takes a waiting request straight to `ACCEPTED`.
 *
 * V1_PROJECT_PLAN.md §2.1 "Peer flow": the person who accepts is a signed-in peer, not an
 * outside provider. DISPATCH.md §4 reaches `ACCEPTED` only through `ASSIGN`, which
 * discloses the Veteran's data to a SERVICE_PROVIDER and so needs a consent evaluation.
 * A peer accept discloses nothing outside SUAS to a provider, so it is its own explicit path
 * rather than a relaxed `ASSIGN`: the generic command table and its consent guard are
 * untouched, and every other caller of `ASSIGN` is still checked.
 *
 * It records the accepter on the request (`accepted_by_user_id`): the helper holds this
 * one request, not the Veteran's case. Runs in the accept transaction, after the case row
 * lock, so the request, the case and the chat thread move together. It adds an Audit Event
 * with ids only (the released Domain Event catalog has no peer-accept event, and the
 * request text never goes into an event payload). A request that is no longer waiting
 * (cancelled, already accepted, past matching) reads as not found, as an accept always has.
 */
export async function peerAcceptRequestInTx(
  tx: Queryable,
  input: {
    readonly tenantId: string;
    readonly serviceRequestId: string;
    readonly actorId: string;
    readonly correlationId?: string;
  },
): Promise<ServiceRequest> {
  const locked = await tx.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests
     WHERE tenant_id = $1 AND service_request_id = $2
     FOR UPDATE`,
    [input.tenantId, input.serviceRequestId],
  );
  const row = locked.rows[0];
  if (
    row === undefined ||
    row.accepted_by_user_id !== null ||
    !PEER_ACCEPTABLE.includes(row.status)
  ) {
    throw new ServiceRequestNotFoundError();
  }

  const updated = await tx.query<RequestRow>(
    `UPDATE service_requests
        SET status = 'ACCEPTED', accepted_by_user_id = $3, updated_at = now()
      WHERE tenant_id = $1 AND service_request_id = $2
      RETURNING ${REQUEST_COLUMNS}`,
    [input.tenantId, input.serviceRequestId, input.actorId],
  );
  const updatedRow = updated.rows[0];
  if (updatedRow === undefined) throw new ServiceRequestNotFoundError();

  await appendAuditEvent(tx, {
    eventType: 'SERVICE_REQUEST_PEER_ACCEPTED',
    action: 'PEER_ACCEPT_SERVICE_REQUEST',
    targetType: 'ServiceRequest',
    targetId: input.serviceRequestId,
    aggregateType: 'ServiceRequest',
    aggregateId: input.serviceRequestId,
    tenantId: input.tenantId,
    actorType: 'USER',
    actorId: input.actorId,
    payload: { case_id: row.case_id, category: row.category, from_status: row.status },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return toRequest(updatedRow);
}

/**
 * Execute a documented Service Request transition.
 *
 * DISPATCH.md §3.1: the expected current state is validated inside the same
 * atomic write that performs the transition, so concurrent incompatible commands
 * yield one winner and the loser writes nothing.
 */
export async function executeServiceRequestCommand(
  pool: Pool,
  input: ServiceRequestCommandInput,
  deps: { disclosureGuard?: DisclosureGuard } = {},
): Promise<ServiceRequest> {
  return withTransaction(pool, (tx) => executeServiceRequestCommandInTx(tx, input, deps));
}

/**
 * A case's requests, newest first. `heldBy` narrows the list to the requests that one
 * helper accepted, so a helper never learns about the Veteran's other requests.
 */
export async function listCaseServiceRequests(
  db: Queryable,
  tenantId: string,
  caseId: string,
  limit = 50,
  heldBy?: string,
): Promise<ServiceRequest[]> {
  const result = await db.query<RequestRow>(
    `SELECT ${REQUEST_COLUMNS} FROM service_requests
     WHERE tenant_id = $1 AND case_id = $2
       AND ($4::uuid IS NULL OR accepted_by_user_id = $4::uuid)
     ORDER BY created_at DESC
     LIMIT $3`,
    [tenantId, caseId, Math.min(limit, 100), heldBy ?? null],
  );
  return result.rows.map(toRequest);
}

/**
 * When the requester confirmed a request in the case's current resolution cycle, or
 * undefined if they did not. The cycle starts at the latest Settlement, so an old
 * confirmation from before a reopen does not count. A case with no Settlement yet is in
 * its first cycle, so every confirmation counts.
 *
 * `CLOSED` is reachable only from `CONFIRMED` (DISPATCH.md §4) and only the requester runs
 * `CONFIRM`, so either status is the requester's confirmation. No confirmation time is stored,
 * so the time returned is the best one on record: `updated_at` for a request still CONFIRMED
 * (exact), and `terminal_at` for a CLOSED one (when it was closed, never before the
 * confirmation). The earliest such time is returned.
 */
export async function findRequesterConfirmation(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<{ readonly confirmedAt: Date } | undefined> {
  const result = await db.query<{ confirmed_at: Date | null }>(
    `SELECT min(t.at) AS confirmed_at
       FROM (
         SELECT CASE WHEN r.status = 'CONFIRMED' THEN r.updated_at ELSE r.terminal_at END AS at
           FROM service_requests r
          WHERE r.tenant_id = $1 AND r.case_id = $2 AND r.status IN ('CONFIRMED', 'CLOSED')
       ) t
      WHERE t.at > COALESCE(
        (SELECT max(settled_at) FROM settlements WHERE tenant_id = $1 AND case_id = $2),
        '-infinity'::timestamptz)`,
    [tenantId, caseId],
  );
  const confirmedAt = result.rows[0]?.confirmed_at;
  return confirmedAt === null || confirmedAt === undefined ? undefined : { confirmedAt };
}
