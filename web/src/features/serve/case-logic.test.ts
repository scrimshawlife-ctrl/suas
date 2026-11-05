import { describe, expect, it } from 'vitest';
import type { ServiceRequestStatus } from '../../api/types';
import { attemptLabel, contactSave, nextStep, statusLabel } from './case-logic';

describe('next progress step for the accepter', () => {
  it('offers only the legal forward command', () => {
    expect(nextStep('ACCEPTED')).toEqual({ command: 'START', label: "I've started helping" });
    expect(nextStep('IN_PROGRESS')).toEqual({ command: 'FULFILL', label: 'Mark as done' });
    expect(nextStep('ASSIGNED')?.command).toBe('ACCEPT');
  });

  it('offers nothing before or after the helper steps, or for requester-only steps', () => {
    const none: ServiceRequestStatus[] = [
      'CREATED',
      'SUBMITTED',
      'TRIAGED',
      'MATCHING',
      'FULFILLED', // CONFIRM belongs to the requester
      'CONFIRMED',
      'CLOSED',
      'CANCELLED',
      'DECLINED',
      'EXPIRED',
      'UNFULFILLABLE',
      'ESCALATED',
    ];
    for (const status of none) expect(nextStep(status), status).toBeNull();
  });

  it('has a plain label for every status', () => {
    expect(statusLabel('IN_PROGRESS')).toBe('In progress');
    expect(statusLabel('SUBMITTED')).toBe('Taken, not started');
  });
});

describe('contact attempt payloads', () => {
  it('sends "waiting to hear" to log-contact-attempt with a PENDING outcome', () => {
    expect(contactSave('PHONE', 'PENDING')).toEqual({
      route: 'log-contact-attempt',
      body: { channel: 'PHONE', outcome: 'PENDING' },
    });
  });

  it('sends every settled outcome to complete-contact', () => {
    for (const outcome of ['REACHED', 'NO_ANSWER', 'LEFT_MESSAGE', 'DECLINED', 'UNABLE'] as const) {
      expect(contactSave('SMS', outcome)).toEqual({
        route: 'complete-contact',
        body: { channel: 'SMS', outcome },
      });
    }
  });

  it('describes an attempt in plain words', () => {
    const base = {
      contact_attempt_id: 'x',
      case_id: 'c',
      logged_by_user_id: 'u',
      attempted_at: '2026-11-04T12:00:00Z',
    };
    expect(attemptLabel({ ...base, channel: 'PHONE', outcome: 'REACHED' }, 'Marcus')).toBe(
      'Phone call, reached Marcus',
    );
    expect(attemptLabel({ ...base, channel: 'EMAIL', outcome: 'NO_ANSWER' }, '')).toBe(
      'Email, no answer',
    );
  });
});
