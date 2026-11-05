import { describe, expect, it } from 'vitest';
import type { NotificationItem } from './api';
import { describeReason, FALLBACK_TEXT, newestFirst, REASON_TEXT } from './notification-reasons';

function item(
  id: string,
  reason: string,
  sent_at: string | null,
  cancelled_at: string | null = null,
): NotificationItem {
  return {
    notification_id: id,
    reason,
    channel: 'IN_APP',
    delivery_status: 'SENT',
    attempt_count: 1,
    subject_type: null,
    subject_id: null,
    sent_at,
    cancelled_at,
  };
}

describe('notification reasons', () => {
  it('has a sentence for each reason in templates.ts except the sign-in codes', () => {
    expect(Object.keys(REASON_TEXT).sort()).toEqual([
      'followup_due',
      'qrf.responder_notified',
      'service_request_update',
      'trusted_contact_alert',
    ]);
    expect(describeReason('followup_due')).toBe('A follow-up is due.');
  });

  it('falls back for a code it does not know, including inherited object keys', () => {
    expect(describeReason('something.new')).toBe(FALLBACK_TEXT);
    expect(describeReason('constructor')).toBe(FALLBACK_TEXT);
  });

  it('hides sign-in codes and cancelled sends, newest first, unsent first', () => {
    const list = newestFirst([
      item('old', 'followup_due', '2026-11-01T00:00:00Z'),
      item('code', 'auth.email_otp', '2026-11-04T00:00:00Z'),
      item('new', 'service_request_update', '2026-11-03T00:00:00Z'),
      item('gone', 'followup_due', null, '2026-11-02T00:00:00Z'),
      item('queued', 'trusted_contact_alert', null),
    ]);
    expect(list.map((n) => n.notification_id)).toEqual(['queued', 'new', 'old']);
  });
});
