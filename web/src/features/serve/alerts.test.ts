import { describe, expect, it } from 'vitest';
import { alertSubjectPath, type Notification } from './alerts';

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

  it('leaves any other subject, or a missing id, as plain text', () => {
    expect(alertSubjectPath(alert({ subject_type: 'SupportCase', subject_id: 'c1' }))).toBeNull();
    expect(
      alertSubjectPath(alert({ subject_type: 'ServiceRequest', subject_id: null })),
    ).toBeNull();
    expect(alertSubjectPath(alert({ subject_type: 'ServiceRequest', subject_id: '' }))).toBeNull();
    expect(alertSubjectPath(alert())).toBeNull();
  });
});
