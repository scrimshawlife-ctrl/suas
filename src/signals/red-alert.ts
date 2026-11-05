/**
 * RED alert to Trusted Contacts.
 *
 * Spec citations:
 * - SUAS-specs SAFETY.md §3.3 (notify a Trusted Contact only with an ACTIVE
 *   `can_receive` + `RED` grant; never on membership alone; re-check before send),
 *   §3.4 (each notify allow/deny is audited)
 * - SUAS-specs TRUSTED_CIRCLE.md §6, §11 (suspended or removed contacts are not
 *   notified)
 * - SUAS-specs NOTIFICATIONS.md §3-§4 (one logical send per identity; consent
 *   evaluated at creation and again before send)
 *
 * Fan-out only: it creates one Notification per eligible contact through the
 * notification service, which evaluates consent and enqueues `notification.send`.
 * `notification.send` re-checks consent at send time. Helpers and request
 * accepters are never recipients; only the veteran's own Trusted Circle is read.
 * Nothing here contacts emergency services (AGENTS.md rule 14).
 */

import type { Pool } from 'pg';
import { listAcceptedContactsWithEmail } from '../consent/index.js';
import type { DurableJobQueuePort } from '../jobs/index.js';
import {
  ChannelPreferenceDisabledError,
  enqueueNotification,
  NotificationConsentDeniedError,
} from '../notifications/index.js';
import type { SupportSignal } from './settlement.js';

export const RED_ALERT_REASON = 'trusted_contact_alert';
export const RED_ALERT_TEMPLATE_VERSION = 'alert@1';
const RED_ALERT_PURPOSE = 'Alert a trusted contact at red';

export interface RedAlertSummary {
  /** Notifications created by this call. */
  readonly enqueued: number;
  /** Contacts whose alert already existed (replay). */
  readonly alreadyEnqueued: number;
  /** Accepted contacts without an active RED grant, or with the channel off. */
  readonly skipped: number;
}

const NONE: RedAlertSummary = { enqueued: 0, alreadyEnqueued: 0, skipped: 0 };

/**
 * Enqueue the RED alert for each consented, accepted contact of the signal's
 * veteran. Replay-safe: the dedupe key is the signal plus the contact, so a
 * redelivered compute job, or a retry after a partial failure, adds nothing.
 * Contacts are attempted independently; the first unexpected error is rethrown
 * after the rest were tried so the job retries.
 */
export async function alertTrustedContactsOfRed(
  pool: Pool,
  signal: SupportSignal,
  deps: { jobQueue: DurableJobQueuePort | undefined },
): Promise<RedAlertSummary> {
  if (signal.level !== 'RED') return NONE;

  const contacts = await listAcceptedContactsWithEmail(pool, signal.tenantId, signal.veteranUserId);
  if (contacts.length === 0) return NONE;
  if (deps.jobQueue === undefined) {
    throw new Error('A job queue is required to send RED alerts to Trusted Contacts.');
  }

  let enqueued = 0;
  let alreadyEnqueued = 0;
  let skipped = 0;
  let failure: Error | undefined;

  for (const contact of contacts) {
    try {
      const result = await enqueueNotification(
        pool,
        {
          tenantId: signal.tenantId,
          ...(contact.contactUserId !== undefined
            ? { recipientUserId: contact.contactUserId }
            : {}),
          destination: contact.inviteEmail,
          reason: RED_ALERT_REASON,
          channel: 'EMAIL',
          templateVersion: RED_ALERT_TEMPLATE_VERSION,
          dedupeKey: `red-alert:${signal.supportSignalId}:${contact.trustedContactId}`,
          subjectType: 'SupportSignal',
          subjectId: signal.supportSignalId,
          disclosure: {
            tenantId: signal.tenantId,
            veteranUserId: signal.veteranUserId,
            permission: 'can_receive',
            scope: 'RED',
            granteeType: 'TRUSTED_CONTACT',
            granteeId: contact.trustedContactId,
            purpose: RED_ALERT_PURPOSE,
          },
        },
        { jobQueue: deps.jobQueue },
      );
      if (result.deduplicated) alreadyEnqueued += 1;
      else enqueued += 1;
    } catch (error) {
      if (
        error instanceof NotificationConsentDeniedError ||
        error instanceof ChannelPreferenceDisabledError
      ) {
        skipped += 1;
      } else {
        failure ??= error instanceof Error ? error : new Error(String(error));
      }
    }
  }

  if (failure !== undefined) throw failure;
  return { enqueued, alreadyEnqueued, skipped };
}
