import { describe, expect, it } from 'vitest';
import type { NotificationItem } from './api';
import {
  describeReason,
  describeWhen,
  FALLBACK_TEXT,
  newestFirst,
  REASON_TEXT,
} from './notification-reasons';

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
      'service_request_expired',
      'service_request_released',
      'service_request_update',
      'trusted_contact_alert',
    ]);
    expect(describeReason('followup_due')).toBe('A follow-up is due.');
  });

  it('words the expiry and release notices plainly', () => {
    expect(describeReason('service_request_expired')).toBe(
      'Your request expired. No one accepted it within 72 hours.',
    );
    expect(describeReason('service_request_released')).toBe(
      'The helper released your request. It is back on the open list.',
    );
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

describe('notification sentences and dates', () => {
  it('the trusted contact notice carries the template disclaimer', () => {
    expect(describeReason('trusted_contact_alert')).toContain(
      'This notice does not describe their situation.',
    );
  });

  it('dates follow the delivery status', () => {
    const fmt = (iso: string) => `on ${iso}`;
    const sent = '2026-11-03T00:00:00Z';
    expect(describeWhen({ delivery_status: 'QUEUED', sent_at: null }, fmt)).toBe('Waiting to send');
    expect(describeWhen({ delivery_status: 'SENT', sent_at: null }, fmt)).toBe('Waiting to send');
    for (const status of ['FAILED', 'BOUNCED', 'UNDELIVERABLE'] as const) {
      expect(describeWhen({ delivery_status: status, sent_at: null }, fmt)).toBe(
        'Could not be delivered',
      );
      expect(describeWhen({ delivery_status: status, sent_at: sent }, fmt)).toBe(
        'Could not be delivered',
      );
    }
    expect(describeWhen({ delivery_status: 'SENT', sent_at: sent }, fmt)).toBe(`on ${sent}`);
    expect(describeWhen({ delivery_status: 'DELIVERED', sent_at: sent }, fmt)).toBe(`on ${sent}`);
  });
});
