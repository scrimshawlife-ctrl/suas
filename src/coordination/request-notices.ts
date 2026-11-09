/**
 * In-app notices to a request's requester about its lifecycle (V1_MVP_PROPOSAL.md R8.4,
 * R8.5): the request expired, or the helper released it.
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
 * Queue one IN_APP notice. A requester who turned in-app notices off is respected and
 * is not an error; any other failure is thrown for the caller to log.
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
