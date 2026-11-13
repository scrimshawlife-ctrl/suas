/**
 * In-app notices to a request's requester about its lifecycle (DISPATCH.md §14.6, §14.7,
 * released in 0.9.0): the request expired, or the helper released it.
 *
 * The notice goes only to the requester, so it discloses nothing outside SUAS: the basis
 * is the system's internal processing, as for the other in-app notices. The text lives in
 * the client; the row carries the reason and the request it concerns, never free text.
 */

import type { Pool } from 'pg';
import { ChannelPreferenceDisabledError, enqueueNotification } from '../notifications/index.js';

export const REQUEST_EXPIRED_REASON = 'service_request_expired';
export const REQUEST_RELEASED_REASON = 'service_request_released';
/** In-app notices render client-side, so no EMAIL catalog entry backs this version. */
export const REQUEST_NOTICE_TEMPLATE_VERSION = 'request-lifecycle@1';

export interface RequestNoticeInput {
  readonly tenantId: string;
  readonly requesterUserId: string;
  readonly serviceRequestId: string;
  readonly reason: typeof REQUEST_EXPIRED_REASON | typeof REQUEST_RELEASED_REASON;
  /** One logical notice, so a replay or a retry never sends it twice. */
  readonly dedupeKey: string;
}

/**
 * Write one IN_APP notice; it is delivered as it is created. A requester who turned in-app
 * notices off is respected and is not an error; any other failure is thrown for the caller
 * to log, and `repairMissedRequestNotices` writes it on a later pass.
 */
export async function notifyRequester(pool: Pool, input: RequestNoticeInput): Promise<void> {
  try {
    await enqueueNotification(pool, {
      tenantId: input.tenantId,
      recipientUserId: input.requesterUserId,
      reason: input.reason,
      channel: 'IN_APP',
      templateVersion: REQUEST_NOTICE_TEMPLATE_VERSION,
      dedupeKey: input.dedupeKey,
      subjectType: 'ServiceRequest',
      subjectId: input.serviceRequestId,
      disclosure: {
        tenantId: input.tenantId,
        veteranUserId: input.requesterUserId,
        permission: 'can_view',
        scope: 'current_requests',
        granteeType: 'SYSTEM',
        granteeId: 'notifications',
        purpose: 'Tell the requester what happened to their own request',
        systemBasis: 'SYSTEM_INTERNAL_PROCESSING',
      },
    });
  } catch (error: unknown) {
    if (!(error instanceof ChannelPreferenceDisabledError)) throw error;
  }
}

/** How long after a release the route's own notice may still be in flight. */
const RELEASE_NOTICE_GRACE_MINUTES = 5;
/** Older transitions are not repaired: the sweep runs every pass, so a day is ample. */
const REPAIR_LOOKBACK_HOURS = 24;
const REPAIR_BATCH_SIZE = 100;

/** A requester who turned IN_APP off gets no notice, so the repair does not retry them. */
const IN_APP_NOT_DISABLED = `NOT EXISTS (
  SELECT 1 FROM notification_preferences p
   WHERE p.tenant_id = c.tenant_id AND p.user_id = c.veteran_user_id
     AND p.channel = 'IN_APP' AND NOT p.enabled)`;

interface MissedNoticeRow {
  tenant_id: string;
  service_request_id: string;
  veteran_user_id: string;
  dedupe_key: string;
}

/**
 * Queue the expiry and release notices whose post-commit write failed (DISPATCH.md §14.6,
 * §14.7: the requester is told; a failure is lag, not loss). Expiry notices share the
 * expiry job's dedupe key. A release notice counts as sent when one exists for that
 * request within the grace window after the event was recorded (both database clock); a
 * repaired one is keyed by the release event.
 * `now` is an injectable clock, as in the expiry job.
 */
export async function repairMissedRequestNotices(
  pool: Pool,
  options: { readonly now?: Date } = {},
): Promise<{ repaired: number; failed: number }> {
  const now = (options.now ?? new Date()).toISOString();
  const missed = await pool.query<MissedNoticeRow>(
    `SELECT r.tenant_id, r.service_request_id, c.veteran_user_id,
            'request-expired:' || r.service_request_id AS dedupe_key
       FROM service_requests r
       JOIN support_cases c ON c.tenant_id = r.tenant_id AND c.case_id = r.case_id
      WHERE r.status = 'EXPIRED'
        AND r.terminal_at > $5::timestamptz - make_interval(hours => $1)
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.tenant_id = r.tenant_id
             AND n.dedupe_key = 'request-expired:' || r.service_request_id)
        AND ${IN_APP_NOT_DISABLED}
     UNION ALL
     SELECT e.tenant_id, e.aggregate_id, c.veteran_user_id,
            'request-released:' || e.aggregate_id || ':event:' || e.event_id
       FROM domain_events e
       JOIN service_requests r ON r.tenant_id = e.tenant_id AND r.service_request_id = e.aggregate_id
       JOIN support_cases c ON c.tenant_id = r.tenant_id AND c.case_id = r.case_id
      WHERE e.event_type = 'SERVICE_REQUEST_RELEASED'
        AND e.recorded_at > $5::timestamptz - make_interval(hours => $1)
        AND e.recorded_at <= $5::timestamptz - make_interval(mins => $2)
        AND NOT EXISTS (
          SELECT 1 FROM notifications n
           WHERE n.tenant_id = e.tenant_id
             AND n.subject_type = 'ServiceRequest' AND n.subject_id = e.aggregate_id
             AND n.reason = $4
             AND (n.dedupe_key = 'request-released:' || e.aggregate_id || ':event:' || e.event_id
                  OR n.created_at BETWEEN e.recorded_at
                                      AND e.recorded_at + make_interval(mins => $2)))
        AND ${IN_APP_NOT_DISABLED}
     LIMIT $3`,
    [
      REPAIR_LOOKBACK_HOURS,
      RELEASE_NOTICE_GRACE_MINUTES,
      REPAIR_BATCH_SIZE,
      REQUEST_RELEASED_REASON,
      now,
    ],
  );

  let repaired = 0;
  let failed = 0;
  for (const row of missed.rows) {
    try {
      await notifyRequester(pool, {
        tenantId: row.tenant_id,
        requesterUserId: row.veteran_user_id,
        serviceRequestId: row.service_request_id,
        reason: row.dedupe_key.startsWith('request-expired:')
          ? REQUEST_EXPIRED_REASON
          : REQUEST_RELEASED_REASON,
        dedupeKey: row.dedupe_key,
      });
      repaired += 1;
    } catch {
      // One bad row must not block the rest; it is picked up again next pass.
      failed += 1;
    }
  }
  return { repaired, failed };
}
