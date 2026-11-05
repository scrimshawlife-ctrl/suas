import type { Schemas } from '../../api/types';

type Notification = Schemas['Notification'];

/** Plain words for notification reason codes. Unknown codes get a neutral line. */
const REASON_TEXT: Record<string, string> = {
  service_request_update: "A request you're helping with was updated",
  followup_due: 'A follow-up is due',
  'qrf.responder_notified': 'Someone was told about a request',
  trusted_contact_alert: 'A trusted contact alert',
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
