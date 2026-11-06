/**
 * Surface reads: canonical facts a surface is allowed to render.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §7.2 (QRF labels rest on canonical facts)
 * - SUAS-specs MVP_REFERENCE.md §9 (summaries only when derived from real data)
 * - SUAS-specs API.md §4 (tenant is server-derived, never a request parameter)
 * - SUAS-specs PRIVACY.md (minimum necessary)
 *
 * These functions select the narrowest set of columns a surface needs. Tenant is
 * always an argument, never a filter the caller may omit.
 */

import type { Queryable } from '../db/index.js';
import type { ServiceCategory, ServiceRequestStatus } from '../coordination/index.js';
import type { QrfFacts } from './qrf.js';

/** Statuses that mean the request is no longer in flight. */
const TERMINAL_STATUSES: readonly ServiceRequestStatus[] = [
  'CLOSED',
  'CONFIRMED',
  'CANCELLED',
  'EXPIRED',
];

interface QrfRow {
  service_request_id: string;
  category: ServiceCategory;
  status: ServiceRequestStatus;
  assigned: boolean;
  assigned_notification_delivered: boolean;
}

export interface ActiveQrf {
  readonly serviceRequestId: string;
  readonly category: ServiceCategory;
  readonly facts: QrfFacts;
}

/**
 * The veteran's newest in-flight Service Request, if one exists.
 *
 * Any category counts (FOOD, TRANSPORTATION, SHELTER, PEER_SUPPORT). `options.category`
 * narrows it to one category for the callers that are about a single kind of request:
 * the legacy `/app` Deploy and Cancel buttons are peer-support commands.
 *
 * `assigned` is the request's own holder (`accepted_by_user_id`): accepting is per
 * request, so another helper holding a different request of the same Veteran never
 * makes this one read as accepted. `assignedNotificationDelivered` reflects a real
 * delivery the system can see: a notification whose subject is this Service Request,
 * addressed to the person who accepted it, that reached a `SENT`/`DELIVERED` state.
 * MVP_REFERENCE.md §7.2 permits `RESPONDER_NOTIFIED` only when the system "actually
 * knows" a notification occurred, so an acceptance alone still reads as `SEARCHING`.
 * The subject linkage this depends on was added by accepted gap proposal P-12
 * (migration 0008).
 */
export async function readActiveQrf(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
  options: { readonly category?: ServiceCategory } = {},
): Promise<ActiveQrf | undefined> {
  const result = await db.query<QrfRow>(
    `SELECT r.service_request_id,
            r.category,
            r.status,
            r.accepted_by_user_id IS NOT NULL AS assigned,
            EXISTS (
              -- §7.2: a delivery the system can actually see: a notification
              -- about this request, to the person who accepted it, that went out.
              SELECT 1 FROM notifications n
               WHERE n.tenant_id = r.tenant_id
                 AND n.recipient_user_id = r.accepted_by_user_id
                 AND n.subject_type = 'ServiceRequest'
                 AND n.subject_id = r.service_request_id
                 AND n.delivery_status IN ('SENT', 'DELIVERED')
            ) AS assigned_notification_delivered
       FROM service_requests r
       JOIN support_cases c
         ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1
        AND c.veteran_user_id = $2
        AND ($4::suas_service_category IS NULL OR r.category = $4::suas_service_category)
        AND r.status <> ALL($3::suas_service_request_status[])
      ORDER BY r.created_at DESC
      LIMIT 1`,
    [tenantId, veteranUserId, TERMINAL_STATUSES, options.category ?? null],
  );

  const row = result.rows[0];
  if (row === undefined) return undefined;

  return {
    serviceRequestId: row.service_request_id,
    category: row.category,
    facts: {
      requestStatus: row.status,
      assigned: row.assigned,
      assignedNotificationDelivered: row.assigned_notification_delivered,
      // Degradation is observed by the caller that owns the dependency, not
      // inferred here from the absence of progress.
      coordinationDegraded: false,
      // UNFULFILLABLE already carries this; there is no separate released
      // "matching ran and found nobody" fact to read.
      matchingExhausted: false,
    },
  };
}
