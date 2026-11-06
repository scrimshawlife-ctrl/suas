/**
 * The full read of one Service Request, for the two people it concerns.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 "Peer flow". Unlike the open list, this shows
 * the timing and the meeting place, so the route calls it only after
 * `resolveCaseAccess` has confirmed the caller is the requester or the accepter. The
 * counterpart's display name is the other person's: the accepter's for the requester,
 * the requester's for the accepter.
 */

import type { Queryable } from '../db/transaction.js';
import type { ServiceCounty } from '../identity/counties.js';
import type { JsonObject } from '../jobs/index.js';
import { MEETING_PLACE_MAX, readDetailText } from './requests.js';

const SUMMARY_READ_MAX = 280;
const TIMING_READ_MAX = 120;

export interface ServiceRequestDetail {
  readonly summary: string | null;
  readonly timing: string | null;
  readonly meetingPlace: string | null;
  readonly createdAt: Date;
  readonly widened: boolean;
  /** The requester's county. */
  readonly county: ServiceCounty | null;
}

interface DetailRow {
  details: JsonObject;
  created_at: Date;
  widened_at: Date | null;
  county: ServiceCounty | null;
}

export async function readServiceRequestDetail(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
): Promise<ServiceRequestDetail | undefined> {
  const result = await db.query<DetailRow>(
    `SELECT r.details, r.created_at, r.widened_at, u.county
       FROM service_requests r
       JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
       JOIN users u ON u.user_id = c.veteran_user_id AND u.tenant_id = c.tenant_id
      WHERE r.tenant_id = $1 AND r.service_request_id = $2`,
    [tenantId, serviceRequestId],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    summary: readDetailText(row.details, 'summary', SUMMARY_READ_MAX),
    timing: readDetailText(row.details, 'timing', TIMING_READ_MAX),
    meetingPlace: readDetailText(row.details, 'meeting_place', MEETING_PLACE_MAX),
    createdAt: row.created_at,
    widened: row.widened_at !== null,
    county: row.county,
  };
}

/** A person's display name, or null when they have not chosen one (or are not in the tenant). */
export async function findDisplayName(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<string | null> {
  const result = await db.query<{ display_name: string | null }>(
    `SELECT display_name FROM users WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, userId],
  );
  return result.rows[0]?.display_name ?? null;
}
