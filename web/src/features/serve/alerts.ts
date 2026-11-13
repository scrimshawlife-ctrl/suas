import type { Schemas } from '../../api/types';
import { paths } from '../../app/paths';

export type Notification = Schemas['Notification'];

/** The Alerts card words reasons with the same map as the Notifications page. */
export { describeReason as alertText } from '../support/notification-reasons';

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
