import type { Schemas } from '../../api/types';
import { paths } from '../../app/paths';

export type Notification = Schemas['Notification'];

/** Plain words for notification reason codes. Unknown codes get a neutral line. */
const REASON_TEXT: Record<string, string> = {
  service_request_update: 'A request you can see was updated',
  followup_due: 'A follow-up is due',
  'qrf.responder_notified': 'Someone was told about a request',
  trusted_contact_alert: 'A trusted contact alert',
  service_request_expired: 'Your request expired 72 hours after you sent it',
  service_request_released: 'The helper released your request. It is back on the open list',
};

const FALLBACK_TEXT = 'You have a new update';

export function alertText(reason: string): string {
  return REASON_TEXT[reason] ?? FALLBACK_TEXT;
}

/** Sign-in codes and cancelled messages are not alerts. */
function isAlert(notification: Notification): boolean {
  return !notification.reason.startsWith('auth.') && notification.cancelled_at === null;
}

/** The latest few alerts, newest first; anything without a sent time goes last. */
export function latestAlerts(notifications: readonly Notification[], count = 4): Notification[] {
  const time = (n: Notification) => (n.sent_at === null ? -Infinity : Date.parse(n.sent_at));
  return notifications
    .filter(isAlert)
    .sort((a, b) => time(b) - time(a))
    .slice(0, count);
}

/** Notices sent only to the person who made the request (the server's request-notices). */
const REQUESTER_REASONS = new Set(['service_request_expired', 'service_request_released']);

/**
 * Where an alert leads. Only a Service Request subject maps to a route: the requester's own
 * request page for a requester notice, otherwise its Serve case page. Anything else stays text.
 */
export function alertSubjectPath(notification: Notification): string | null {
  const { reason, subject_type, subject_id } = notification;
  if (subject_type !== 'ServiceRequest' || !subject_id) return null;
  return REQUESTER_REASONS.has(reason) ? paths.requestDetail(subject_id) : paths.case(subject_id);
}
