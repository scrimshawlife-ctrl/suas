import { describe, expect, it } from 'vitest';
import { alertSubjectPath, alertText, type Notification } from './alerts';

function alert(overrides: Partial<Notification> = {}): Notification {
  return {
    notification_id: '00000000-0000-4000-8000-000000000001',
    reason: 'service_request_update',
    channel: 'IN_APP',
    delivery_status: 'SENT',
    attempt_count: 1,
    subject_type: null,
    subject_id: null,
    sent_at: '2026-11-09T12:00:00Z',
    cancelled_at: null,
    ...overrides,
  };
}

describe('alertSubjectPath', () => {
  it('links a Service Request alert to its Serve case page', () => {
    expect(alertSubjectPath(alert({ subject_type: 'ServiceRequest', subject_id: 'r1' }))).toBe(
      '/serve/requests/r1',
    );
  });

  it("links a requester notice to the person's own request, not the Serve case page", () => {
    for (const reason of ['service_request_released', 'service_request_expired']) {
      expect(
        alertSubjectPath(alert({ reason, subject_type: 'ServiceRequest', subject_id: 'r1' })),
      ).toBe('/requests/r1');
    }
  });

  it('leaves any other subject, or a missing id, as plain text', () => {
    expect(alertSubjectPath(alert({ subject_type: 'SupportCase', subject_id: 'c1' }))).toBeNull();
    expect(
      alertSubjectPath(alert({ subject_type: 'ServiceRequest', subject_id: null })),
    ).toBeNull();
    expect(alertSubjectPath(alert({ subject_type: 'ServiceRequest', subject_id: '' }))).toBeNull();
    expect(alertSubjectPath(alert())).toBeNull();
  });
});

describe('alertText', () => {
  it('words the expiry and release notices', () => {
    // True whether or not someone accepted and then released it: release keeps the clock (R8.4).
    expect(alertText('service_request_expired')).toBe(
      'Your request expired 72 hours after you sent it',
    );
    expect(alertText('service_request_expired')).not.toMatch(/No one accepted/);
    expect(alertText('service_request_released')).toMatch(/^The helper released your request\./);
  });
});
