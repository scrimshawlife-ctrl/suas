/**
 * Expiry: a Service Request nobody accepted within the TTL expires.
 *
 * Spec citations:
 * - suas-specs V1_MVP_PROPOSAL.md R8.4 (proposal, not released): the TTL is 72 hours from
 *   `submitted_at` on the server clock; the actor is System; only a request nobody has
 *   accepted expires. DISPATCH.md §4: `EXPIRE` runs from the pre-accept states, and the
 *   expected-status check still applies.
 * - AGENTS.md rules 8-9: state is shared and persistent, and the job is replay-safe.
 *
 * The TTL is the `request_expiry_hours` setting (migration 0020). Each request expires
 * in its own transaction that locks the case, then the request, re-checks it is still
 * due (a release or accept in between makes it not due), and runs `EXPIRE` through the
 * state machine. So a repeated or overlapping run expires a request once, and an accept
 * and an expiry serialize on the same locks `acceptServiceRequest` takes. The requester
 * is notified after the commit.
 */

import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import { notifyRequester, REQUEST_EXPIRED_REASON } from './request-notices.js';
import { executeServiceRequestCommandInTx, PEER_ACCEPTABLE } from './requests.js';
import type { ServiceRequestStatus } from './request-transitions.js';

export const REQUEST_EXPIRY_SETTING_KEY = 'request_expiry_hours';
const DEFAULT_BATCH_SIZE = 200;
const ACTOR_ID = 'request-expiry-job';

export class InvalidRequestExpiryError extends Error {
  constructor() {
    super(`Setting "${REQUEST_EXPIRY_SETTING_KEY}" must be a whole number of hours, one or more.`);
    this.name = 'InvalidRequestExpiryError';
  }
}

/** The stored TTL in hours. Fails loudly rather than guessing a default. */
export async function readRequestExpiryHours(db: Queryable): Promise<number> {
  const result = await db.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE setting_key = $1`,
    [REQUEST_EXPIRY_SETTING_KEY],
  );
  const value = result.rows[0]?.value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new InvalidRequestExpiryError();
  }
  return value;
}

/**
 * Due: still waiting for an accept, no holder, and submitted at or before the cutoff.
 * `$1` is the cutoff (the clock minus the TTL) and `$2` the waiting statuses. A release
 * keeps `submitted_at`, so a released request expires on its original clock (R8.4, D-061).
 */
const DUE_CONDITIONS = `
  r.status = ANY($2::suas_service_request_status[])
  AND r.accepted_by_user_id IS NULL
  AND r.submitted_at <= $1::timestamptz`;

export interface ExpiredRequest {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly requesterUserId: string;
}

export interface ExpireDueRequestsResult {
  readonly ttlHours: number;
  readonly expired: readonly ExpiredRequest[];
  /** Requests that expired but whose notice failed; the sweep does not retry them. */
  readonly noticeFailures: number;
}

export interface ExpireDueRequestsOptions {
  /** Injectable clock, as elsewhere in the code base. */
  readonly now?: Date;
  readonly batchSize?: number;
}

interface CandidateRow {
  service_request_id: string;
  tenant_id: string;
  case_id: string;
}

/** Expire one request if it is still due. Returns undefined when it no longer is. */
async function expireOne(
  pool: Pool,
  candidate: CandidateRow,
  cutoff: Date,
  ttlHours: number,
  now: Date,
): Promise<ExpiredRequest | undefined> {
  return withTransaction(pool, async (tx) => {
    // Case first, then request: the order `acceptServiceRequest` takes its locks in.
    const owner = await tx.query<{ veteran_user_id: string }>(
      `SELECT veteran_user_id FROM support_cases WHERE tenant_id = $1 AND case_id = $2 FOR UPDATE`,
      [candidate.tenant_id, candidate.case_id],
    );
    const requesterUserId = owner.rows[0]?.veteran_user_id;
    if (requesterUserId === undefined) return undefined;

    const due = await tx.query<{ status: ServiceRequestStatus }>(
      `SELECT r.status FROM service_requests r
        WHERE r.tenant_id = $3 AND r.service_request_id = $4 AND ${DUE_CONDITIONS}
        FOR UPDATE`,
      [
        cutoff.toISOString(),
        [...PEER_ACCEPTABLE],
        candidate.tenant_id,
        candidate.service_request_id,
      ],
    );
    const status = due.rows[0]?.status;
    if (status === undefined) return undefined;

    await executeServiceRequestCommandInTx(tx, {
      tenantId: candidate.tenant_id,
      serviceRequestId: candidate.service_request_id,
      command: 'EXPIRE',
      actorId: ACTOR_ID,
      actorType: 'SYSTEM',
      expectedStatus: status,
    });

    await appendAuditEvent(tx, {
      eventType: 'SERVICE_REQUEST_EXPIRED',
      action: 'EXPIRE_SERVICE_REQUEST',
      targetType: 'ServiceRequest',
      targetId: candidate.service_request_id,
      aggregateType: 'ServiceRequest',
      aggregateId: candidate.service_request_id,
      tenantId: candidate.tenant_id,
      actorType: 'SYSTEM',
      actorId: ACTOR_ID,
      occurredAt: now,
      payload: { case_id: candidate.case_id, from_status: status, ttl_hours: ttlHours },
    });

    return {
      tenantId: candidate.tenant_id,
      serviceRequestId: candidate.service_request_id,
      requesterUserId,
    };
  });
}

/**
 * Expire every request that has waited out the TTL. Safe to run on any schedule and from
 * several workers at once.
 */
export async function expireDueRequests(
  pool: Pool,
  options: ExpireDueRequestsOptions = {},
): Promise<ExpireDueRequestsResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const ttlHours = await readRequestExpiryHours(pool);
  const cutoff = new Date(now.getTime() - ttlHours * 3_600_000);

  const expired: ExpiredRequest[] = [];
  let noticeFailures = 0;
  for (;;) {
    const candidates = await pool.query<CandidateRow>(
      `SELECT r.service_request_id, r.tenant_id, r.case_id
         FROM service_requests r
        WHERE ${DUE_CONDITIONS}
        ORDER BY r.submitted_at, r.service_request_id
        LIMIT $3`,
      [cutoff.toISOString(), [...PEER_ACCEPTABLE], batchSize],
    );

    let expiredInBatch = 0;
    for (const candidate of candidates.rows) {
      const result = await expireOne(pool, candidate, cutoff, ttlHours, now);
      if (result === undefined) continue;
      expired.push(result);
      expiredInBatch += 1;
      try {
        await notifyRequester(pool, {
          tenantId: result.tenantId,
          requesterUserId: result.requesterUserId,
          serviceRequestId: result.serviceRequestId,
          reason: REQUEST_EXPIRED_REASON,
          dedupeKey: `request-expired:${result.serviceRequestId}`,
        });
      } catch {
        noticeFailures += 1;
      }
    }
    // A short batch is the last one. A full batch that expired nothing means every
    // candidate changed under us; stop rather than spin.
    if (candidates.rows.length < batchSize || expiredInBatch === 0) break;
  }

  return { ttlHours, expired, noticeFailures };
}
