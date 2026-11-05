import type { NotificationItem } from './api';

/**
 * Plain sentence for each `reason` in src/notifications/templates.ts. The two `auth.*`
 * sign-in code reasons are not listed because the screen hides them.
 */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  trusted_contact_alert:
    'Someone who named you as a trusted contact asked SUAS to send you this notice. This notice does not describe their situation.',
  followup_due: 'A follow-up is due.',
  'qrf.responder_notified': 'You were told about a request that needs help.',
  service_request_update: 'A request you can see was updated.',
};

export const FALLBACK_TEXT = 'You have a new update.';

export function describeReason(reason: string): string {
  return Object.hasOwn(REASON_TEXT, reason) ? REASON_TEXT[reason]! : FALLBACK_TEXT;
}

/** Sign-in codes are noise here, and a cancelled notification was never sent. */
export function isShown(item: Pick<NotificationItem, 'reason' | 'cancelled_at'>): boolean {
  return !item.reason.startsWith('auth.') && item.cancelled_at === null;
}

/** Newest first. Notifications with no send time yet come first: they are the newest. */
export function newestFirst(items: readonly NotificationItem[]): NotificationItem[] {
  return items.filter(isShown).sort((a, b) => {
    if (a.sent_at === b.sent_at) return 0;
    if (a.sent_at === null) return -1;
    if (b.sent_at === null) return 1;
    return b.sent_at.localeCompare(a.sent_at);
  });
}

/** When a notification was sent, by what the server recorded for its delivery. */
export function describeWhen(
  item: Pick<NotificationItem, 'delivery_status' | 'sent_at'>,
  formatDate: (iso: string) => string,
): string {
  if (
    item.delivery_status === 'FAILED' ||
    item.delivery_status === 'BOUNCED' ||
    item.delivery_status === 'UNDELIVERABLE'
  ) {
    return 'Could not be delivered';
  }
  if (item.delivery_status === 'QUEUED' || item.sent_at === null) return 'Waiting to send';
  return formatDate(item.sent_at);
}
