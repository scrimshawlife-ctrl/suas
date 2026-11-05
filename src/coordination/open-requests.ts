/**
 * Open-request list for people who can accept.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Peer flow", "County", "Widening": a person sees open
 *   requests in their own county, plus requests from bordering counties once the
 *   widening job has opened them. An accepted request leaves everyone else's list.
 * - SUAS-specs CASES.md §9 / API.md §5 (lists are bounded and keyset-paginated).
 * - SUAS-specs PRIVACY.md §4 (minimum necessary): the open list shows category, county,
 *   status and the one-line summary. Timing and the meeting place wait until the person
 *   has accepted.
 *
 * The list is advisory. `acceptServiceRequest` repeats the same eligibility check
 * under the case row lock, so a stale list can never produce a second winner.
 */

import type { Queryable } from '../db/transaction.js';
import type { ServiceCounty } from '../identity/counties.js';
import type { ServiceCategory, ServiceRequestStatus } from './request-transitions.js';

/** API.md §5. */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface OpenRequestSummary {
  readonly serviceRequestId: string;
  readonly caseId: string;
  readonly category: ServiceCategory;
  readonly status: ServiceRequestStatus;
  /** The requester's county. */
  readonly county: ServiceCounty;
  /** True once the widening job has opened the request to bordering counties. */
  readonly widened: boolean;
  /** The requester's one-line summary; null if the request carries none. */
  readonly summary: string | null;
  /** The requester's display name, for the accepter's own list. */
  readonly requesterDisplayName: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** When the request reached a terminal status; null while it is live. */
  readonly closedAt: Date | null;
}

export interface RequestListPage {
  readonly requests: readonly OpenRequestSummary[];
  /** Opaque keyset cursor; absent when no further page exists. */
  readonly nextCursor: string | undefined;
}

export class CountyRequiredError extends Error {
  readonly code = 'COUNTY_REQUIRED';
  readonly httpStatus = 422;

  constructor() {
    super('Choose a county before listing or accepting requests.');
    this.name = 'CountyRequiredError';
  }
}

export class InvalidCursorError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super('The pagination cursor is not valid.');
    this.name = 'InvalidCursorError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keyset cursor over (created_at, service_request_id), stable under new inserts. */
function encodeCursor(createdAt: Date, serviceRequestId: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${serviceRequestId}`, 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | undefined {
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (parts.length !== 2) return undefined;
    const [createdAt, id] = parts;
    if (createdAt === undefined || id === undefined) return undefined;
    // Validated here so a crafted-but-decodable cursor is a 400, not a 500 from the
    // casts in the keyset predicate.
    if (Number.isNaN(Date.parse(createdAt))) return undefined;
    if (!UUID_PATTERN.test(id)) return undefined;
    return { createdAt, id };
  } catch {
    return undefined;
  }
}

/** The person's own county, or undefined when they have not picked one. */
export async function findUserCounty(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<ServiceCounty | undefined> {
  const result = await db.query<{ county: ServiceCounty | null }>(
    `SELECT county FROM users WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
    [tenantId, userId],
  );
  return result.rows[0]?.county ?? undefined;
}

/**
 * SQL conditions that make a request open to one viewer. Shared by the list and by
 * the accept guard so the two cannot disagree. Expects the aliases `r`
 * (service_requests), `c` (support_cases) and `u` (the requester's users row).
 *
 * Widening seam: today a request is visible in the requester's county. When the
 * widening job (plan F6) stamps `r.widened_at`, bordering counties see it too; no
 * change is needed here.
 */
export function openToViewerConditions(viewerIdParam: string, viewerCountyParam: string): string[] {
  return [
    ...OPEN_REQUEST_STATE_CONDITIONS,
    ...visibleToViewerConditions(viewerIdParam, viewerCountyParam),
  ];
}

/**
 * The conditions that make a request visible to one viewer by who and where they are,
 * not by what state the request is in. The accept guard runs these first, so a person
 * who could never see a request cannot tell it exists from the answer to an accept.
 */
export function visibleToViewerConditions(
  viewerIdParam: string,
  viewerCountyParam: string,
): string[] {
  return [
    // Never your own request.
    `c.veteran_user_id <> ${viewerIdParam}::uuid`,
    `u.status = 'ACTIVE' AND u.deleted_at IS NULL`,
    `(u.county = ${viewerCountyParam}::suas_county
      OR (r.widened_at IS NOT NULL
          AND EXISTS (SELECT 1 FROM county_adjacency adj
                       WHERE adj.county = ${viewerCountyParam}::suas_county
                         AND adj.adjacent_county = u.county)))`,
  ];
}

/**
 * The case may still take a new accepter. A case another helper already holds a request
 * of (`ASSIGNED`, `ACTIVE`, `FOLLOWUP`) stays open to others for its other requests:
 * accepting is per request. A `RESOLVED` or `CLOSED` case does not.
 */
export const OPEN_CASE_STATE_CONDITION = `c.status IN ('OPEN', 'TRIAGED', 'ASSIGNED', 'ACTIVE', 'FOLLOWUP')`;

/** The state conditions: the request is still waiting for someone to accept it. */
export const OPEN_REQUEST_STATE_CONDITIONS: readonly string[] = [
  `r.status = ANY(ARRAY['SUBMITTED','TRIAGED','MATCHING']::suas_service_request_status[])`,
  OPEN_CASE_STATE_CONDITION,
  `r.accepted_by_user_id IS NULL`,
];

export const REQUEST_REQUESTER_FROM = `
  service_requests r
  JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
  JOIN users u ON u.user_id = c.veteran_user_id AND u.tenant_id = c.tenant_id`;

interface ListRow {
  service_request_id: string;
  case_id: string;
  category: ServiceCategory;
  status: ServiceRequestStatus;
  county: ServiceCounty;
  widened_at: Date | null;
  summary: string | null;
  requester_display_name: string | null;
  created_at: Date;
  updated_at: Date;
  terminal_at: Date | null;
}

export interface ListRequestsFilters {
  /**
   * `open`: requests this person could accept. `mine`: requests they accepted.
   * `requested`: requests they made themselves, in any status.
   */
  readonly ownership: 'open' | 'mine' | 'requested';
}

/**
 * One bounded page of service requests for a viewer.
 *
 * `open` needs the viewer's county; a person with none gets `CountyRequiredError`
 * instead of a silently empty list, so a client can prompt for it.
 */
export async function readRequestList(
  db: Queryable,
  tenantId: string,
  viewerUserId: string,
  filters: ListRequestsFilters,
  page: { cursor?: string; limit?: number } = {},
): Promise<RequestListPage> {
  const limit = Math.min(Math.max(page.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const values: unknown[] = [tenantId];
  const conditions: string[] = ['r.tenant_id = $1'];

  if (filters.ownership === 'open') {
    const county = await findUserCounty(db, tenantId, viewerUserId);
    if (county === undefined) throw new CountyRequiredError();
    values.push(viewerUserId, county);
    conditions.push(...openToViewerConditions('$2', '$3'));
  } else if (filters.ownership === 'requested') {
    values.push(viewerUserId);
    conditions.push(`c.veteran_user_id = $2::uuid`);
  } else {
    values.push(viewerUserId);
    conditions.push(`r.accepted_by_user_id = $2::uuid`);
  }

  if (page.cursor !== undefined) {
    const decoded = decodeCursor(page.cursor);
    if (decoded === undefined) throw new InvalidCursorError();
    values.push(decoded.createdAt, decoded.id);
    conditions.push(
      `(r.created_at, r.service_request_id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`,
    );
  }

  // One row over the page size tells us whether another page exists.
  values.push(limit + 1);

  const result = await db.query<ListRow>(
    `SELECT r.service_request_id, r.case_id, r.category, r.status, u.county,
            r.widened_at, CASE WHEN jsonb_typeof(r.details->'summary') = 'string'
                 THEN left(r.details->>'summary', 280) END AS summary,
            u.display_name AS requester_display_name,
            r.created_at, r.updated_at, r.terminal_at
       FROM ${REQUEST_REQUESTER_FROM}
      WHERE ${conditions.join(' AND ')}
      ORDER BY r.created_at DESC, r.service_request_id DESC
      LIMIT $${values.length}`,
    values,
  );

  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  const hasMore = result.rows.length > limit;

  return {
    requests: rows.map((row) => ({
      serviceRequestId: row.service_request_id,
      caseId: row.case_id,
      category: row.category,
      status: row.status,
      county: row.county,
      widened: row.widened_at !== null,
      summary: row.summary,
      requesterDisplayName: row.requester_display_name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.terminal_at,
    })),
    nextCursor:
      hasMore && last !== undefined
        ? encodeCursor(last.created_at, last.service_request_id)
        : undefined,
  };
}
