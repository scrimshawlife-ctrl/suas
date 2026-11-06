/**
 * Widening: an unaccepted Service Request opens to bordering counties.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Widening": an unaccepted request widens to bordering
 *   counties (real borders, within the launch list) after the stored delay
 *   (default 30 minutes). §4.3 F6. Whether widening repeats is undecided (§8 #8),
 *   so a request widens once: `widened_at` is set once and never cleared.
 * - AGENTS.md rules 8-9: state is shared and persistent, and the job is replay-safe.
 *
 * Who can see a widened request is recorded durably by `service_requests.widened_at`
 * plus the `county_adjacency` table; the helper list (open-requests.ts) reads both.
 * Each widening also writes an Audit Event listing the counties it reached.
 *
 * Replay safety: each request is widened in its own transaction that re-checks every
 * condition under row locks, so a repeated or overlapping run finds nothing to do
 * for a request that already widened, and writes no second Audit Event. The case row
 * is locked before the request row, the same order `acceptServiceRequest` uses, so
 * a widening and an accept serialize instead of deadlocking.
 */

import type { Pool } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import { OPEN_CASE_STATE_CONDITION } from './open-requests.js';

export const WIDENING_DELAY_SETTING_KEY = 'widening_delay_minutes';
const DEFAULT_BATCH_SIZE = 200;
const ACTOR_ID = 'request-widening-job';

export class InvalidWideningDelayError extends Error {
  constructor() {
    super(
      `Setting "${WIDENING_DELAY_SETTING_KEY}" must be a whole number of minutes, zero or more.`,
    );
    this.name = 'InvalidWideningDelayError';
  }
}

/** The stored delay in minutes. Fails loudly rather than guessing a default. */
export async function readWideningDelayMinutes(db: Queryable): Promise<number> {
  const result = await db.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE setting_key = $1`,
    [WIDENING_DELAY_SETTING_KEY],
  );
  const value = result.rows[0]?.value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidWideningDelayError();
  }
  return value;
}

/**
 * A request is due when it is still open to be accepted, has not widened, and has
 * waited at least the delay. The status sets mirror `openToViewerConditions`; a
 * request outside them (accepted, cancelled, closed, expired) never widens.
 * `$1` is the cutoff: the clock minus the delay.
 */
const DUE_CONDITIONS = `
  r.widened_at IS NULL
  AND r.status = ANY(ARRAY['SUBMITTED','TRIAGED','MATCHING']::suas_service_request_status[])
  AND r.submitted_at <= $1::timestamptz
  AND ${OPEN_CASE_STATE_CONDITION}
  AND r.accepted_by_user_id IS NULL
  AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
  AND u.county IS NOT NULL`;

const FROM_REQUEST_CASE_REQUESTER = `
  service_requests r
  JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
  JOIN users u ON u.user_id = c.veteran_user_id AND u.tenant_id = c.tenant_id`;

export interface WidenedRequest {
  readonly tenantId: string;
  readonly serviceRequestId: string;
  readonly fromCounty: string;
  /** Bordering counties that can now see the request. */
  readonly reachedCounties: readonly string[];
}

export interface WidenDueRequestsResult {
  readonly delayMinutes: number;
  readonly widened: readonly WidenedRequest[];
}

export interface WidenDueRequestsOptions {
  /** Injectable clock, as elsewhere in the code base. */
  readonly now?: Date;
  readonly batchSize?: number;
}

interface CandidateRow {
  service_request_id: string;
  tenant_id: string;
  case_id: string;
}

/** Widen one request if it is still due. Returns undefined when it no longer is. */
async function widenOne(
  pool: Pool,
  candidate: CandidateRow,
  cutoff: Date,
  delayMinutes: number,
  now: Date,
): Promise<WidenedRequest | undefined> {
  return withTransaction(pool, async (tx) => {
    // Case first, then request: the order `acceptServiceRequest` takes its locks in.
    await tx.query(`SELECT 1 FROM support_cases WHERE tenant_id = $1 AND case_id = $2 FOR UPDATE`, [
      candidate.tenant_id,
      candidate.case_id,
    ]);
    const due = await tx.query<{ county: string }>(
      `SELECT u.county
         FROM ${FROM_REQUEST_CASE_REQUESTER}
        WHERE r.tenant_id = $2 AND r.service_request_id = $3 AND ${DUE_CONDITIONS}
        FOR UPDATE OF r`,
      [cutoff.toISOString(), candidate.tenant_id, candidate.service_request_id],
    );
    const fromCounty = due.rows[0]?.county;
    if (fromCounty === undefined) return undefined;

    const bordering = await tx.query<{ adjacent_county: string }>(
      `SELECT adjacent_county FROM county_adjacency
        WHERE county = $1::suas_county ORDER BY adjacent_county`,
      [fromCounty],
    );
    const reachedCounties = bordering.rows.map((row) => row.adjacent_county);

    await tx.query(
      `UPDATE service_requests
          SET widened_at = $3::timestamptz, updated_at = now()
        WHERE tenant_id = $1 AND service_request_id = $2`,
      [candidate.tenant_id, candidate.service_request_id, now.toISOString()],
    );

    await appendAuditEvent(tx, {
      eventType: 'SERVICE_REQUEST_WIDENED',
      action: 'WIDEN_SERVICE_REQUEST',
      targetType: 'ServiceRequest',
      targetId: candidate.service_request_id,
      aggregateType: 'ServiceRequest',
      aggregateId: candidate.service_request_id,
      tenantId: candidate.tenant_id,
      actorType: 'SYSTEM',
      actorId: ACTOR_ID,
      occurredAt: now,
      payload: {
        case_id: candidate.case_id,
        from_county: fromCounty,
        reached_counties: reachedCounties,
        delay_minutes: delayMinutes,
      },
    });

    return {
      tenantId: candidate.tenant_id,
      serviceRequestId: candidate.service_request_id,
      fromCounty,
      reachedCounties,
    };
  });
}

/**
 * Widen every request that has waited out the stored delay. Safe to run on any
 * schedule and from several workers at once.
 */
export async function widenDueRequests(
  pool: Pool,
  options: WidenDueRequestsOptions = {},
): Promise<WidenDueRequestsResult> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const delayMinutes = await readWideningDelayMinutes(pool);
  const cutoff = new Date(now.getTime() - delayMinutes * 60_000);

  const widened: WidenedRequest[] = [];
  for (;;) {
    const candidates = await pool.query<CandidateRow>(
      `SELECT r.service_request_id, r.tenant_id, r.case_id
         FROM ${FROM_REQUEST_CASE_REQUESTER}
        WHERE ${DUE_CONDITIONS}
        ORDER BY r.submitted_at, r.service_request_id
        LIMIT $2`,
      [cutoff.toISOString(), batchSize],
    );

    let widenedInBatch = 0;
    for (const candidate of candidates.rows) {
      const result = await widenOne(pool, candidate, cutoff, delayMinutes, now);
      if (result !== undefined) {
        widened.push(result);
        widenedInBatch += 1;
      }
    }
    // A short batch is the last one. A full batch that widened nothing means every
    // candidate changed under us; stop rather than spin.
    if (candidates.rows.length < batchSize || widenedInBatch === 0) break;
  }

  return { delayMinutes, widened };
}
