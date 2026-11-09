import { describe, expect, it } from 'vitest';
import type { ServiceRequestStatus } from '../../api/types';
import { progressSteps } from './card-copy';
import {
  canCancel,
  cardFromStatus,
  isEditableStatus,
  isSettled,
  listChipForStatus,
  resolveRequestCard,
  type RequestCard,
} from './request-card';

const ID = '11111111-1111-4111-8111-111111111111';

const EXPECTED: Record<ServiceRequestStatus, RequestCard> = {
  CREATED: 'RECEIVED',
  SUBMITTED: 'RECEIVED',
  TRIAGED: 'MATCHING',
  MATCHING: 'MATCHING',
  ASSIGNED: 'MATCHING',
  ACCEPTED: 'ACCEPTED',
  IN_PROGRESS: 'ACCEPTED',
  FULFILLED: 'ACCEPTED',
  CONFIRMED: 'ACCEPTED',
  CLOSED: 'ACCEPTED',
  CANCELLED: 'CANCELLED',
  DECLINED: 'UNAVAILABLE',
  EXPIRED: 'UNAVAILABLE',
  UNFULFILLABLE: 'UNAVAILABLE',
  ESCALATED: 'MATCHING',
};

describe('cardFromStatus', () => {
  it.each(Object.entries(EXPECTED))('%s shows the %s card', (status, card) => {
    expect(cardFromStatus(status as ServiceRequestStatus)).toBe(card);
  });

  it('never claims a notification or a coordination fault from a status alone', () => {
    const cards = Object.keys(EXPECTED).map((s) => cardFromStatus(s as ServiceRequestStatus));
    expect(cards).not.toContain('NOTIFIED');
    expect(cards).not.toContain('DEGRADED');
  });
});

describe('resolveRequestCard', () => {
  const active = (state: string, id = ID) => ({
    service_request_id: id,
    state,
    cancellable: true,
  });

  it.each([
    ['REQUESTED', 'SUBMITTED', 'RECEIVED'],
    ['SEARCHING', 'MATCHING', 'MATCHING'],
    ['RESPONDER_NOTIFIED', 'ASSIGNED', 'NOTIFIED'],
    ['RESPONDER_ACCEPTED', 'ACCEPTED', 'ACCEPTED'],
    ['NO_RESPONDER_CURRENTLY_AVAILABLE', 'UNFULFILLABLE', 'UNAVAILABLE'],
    ['DEGRADED', 'MATCHING', 'DEGRADED'],
  ])('active_qrf %s decides the card for its own request', (state, status, card) => {
    expect(
      resolveRequestCard({
        requestId: ID,
        status: status as ServiceRequestStatus,
        activeQrf: active(state),
      }),
    ).toBe(card);
  });

  it('lets active_qrf reach NOTIFIED, which a status alone never can', () => {
    expect(
      resolveRequestCard({
        requestId: ID,
        status: 'ASSIGNED',
        activeQrf: active('RESPONDER_NOTIFIED'),
      }),
    ).toBe('NOTIFIED');
    expect(resolveRequestCard({ requestId: ID, status: 'ASSIGNED', activeQrf: null })).toBe(
      'MATCHING',
    );
  });

  it('ignores active_qrf that belongs to another request', () => {
    expect(
      resolveRequestCard({
        requestId: ID,
        status: 'MATCHING',
        activeQrf: active('RESPONDER_NOTIFIED', '22222222-2222-4222-8222-222222222222'),
      }),
    ).toBe('MATCHING');
  });

  it('does not hold a fresher cancelled or accepted read at an earlier state', () => {
    expect(
      resolveRequestCard({
        requestId: ID,
        status: 'CANCELLED',
        activeQrf: active('RESPONDER_NOTIFIED'),
      }),
    ).toBe('CANCELLED');
    expect(
      resolveRequestCard({ requestId: ID, status: 'ACCEPTED', activeQrf: active('SEARCHING') }),
    ).toBe('ACCEPTED');
  });

  it('lets a dead-end status win over a stale active_qrf, but not over DEGRADED', () => {
    for (const status of ['EXPIRED', 'UNFULFILLABLE', 'DECLINED'] as const) {
      expect(resolveRequestCard({ requestId: ID, status, activeQrf: active('SEARCHING') })).toBe(
        'UNAVAILABLE',
      );
    }
    expect(
      resolveRequestCard({ requestId: ID, status: 'EXPIRED', activeQrf: active('DEGRADED') }),
    ).toBe('DEGRADED');
  });

  it('falls back to the status for a state it does not know', () => {
    expect(
      resolveRequestCard({
        requestId: ID,
        status: 'SUBMITTED',
        activeQrf: active('SOMETHING_NEW'),
      }),
    ).toBe('RECEIVED');
  });
});

describe('canCancel', () => {
  it('follows the statuses that have a CANCEL edge', () => {
    const yes = [
      'CREATED',
      'SUBMITTED',
      'TRIAGED',
      'MATCHING',
      'ASSIGNED',
      'ACCEPTED',
      'IN_PROGRESS',
    ];
    for (const status of Object.keys(EXPECTED)) {
      expect(
        canCancel({ requestId: ID, status: status as ServiceRequestStatus, activeQrf: null }),
      ).toBe(yes.includes(status));
    }
  });

  it('offers no cancel once fulfilled, whatever a stale active_qrf says', () => {
    expect(
      canCancel({
        requestId: ID,
        status: 'FULFILLED',
        activeQrf: { service_request_id: ID, state: 'RESPONDER_ACCEPTED', cancellable: true },
      }),
    ).toBe(false);
  });

  it('defers to the server for the active request', () => {
    expect(
      canCancel({
        requestId: ID,
        status: 'MATCHING',
        activeQrf: { service_request_id: ID, state: 'SEARCHING', cancellable: false },
      }),
    ).toBe(false);
  });
});

describe('progressSteps', () => {
  const states = (card: RequestCard) => progressSteps(card, '7:42 PM').map((s) => s.state);

  it('marks only what is recorded', () => {
    expect(states('RECEIVED')).toEqual(['now', 'todo', 'todo', 'todo']);
    expect(states('MATCHING')).toEqual(['done', 'now', 'todo', 'todo']);
    expect(states('NOTIFIED')).toEqual(['done', 'done', 'now', 'todo']);
  });

  it('never ticks "A veteran was notified" without a recorded notification', () => {
    const notified = (card: RequestCard) =>
      progressSteps(card, '7:42 PM').find((s) => s.label === 'A veteran was notified')?.state;
    expect(notified('RECEIVED')).toBe('todo');
    expect(notified('MATCHING')).toBe('todo');
    expect(notified('NOTIFIED')).toBe('now');
  });

  it('has no track for the accepted card or the cards that end the search', () => {
    expect(progressSteps('ACCEPTED')).toEqual([]);
    expect(progressSteps('UNAVAILABLE')).toEqual([]);
    expect(progressSteps('DEGRADED')).toEqual([]);
    expect(progressSteps('CANCELLED')).toEqual([]);
  });

  it('says "Not yet" for steps that are not recorded', () => {
    expect(progressSteps('MATCHING', '7:42 PM').map((s) => s.detail)).toEqual([
      '7:42 PM',
      'Now',
      'Not yet',
      'Not yet',
    ]);
  });
});

describe('list chips and polling', () => {
  it('labels a closed request Done and a fulfilled one as marked done, not done', () => {
    expect(listChipForStatus('CLOSED').label).toBe('Done');
    expect(listChipForStatus('CONFIRMED').label).toBe('Done');
    expect(listChipForStatus('FULFILLED').label).toBe('Marked done');
  });

  it('never lists a notified or degraded chip', () => {
    const labels = Object.keys(EXPECTED).map(
      (s) => listChipForStatus(s as ServiceRequestStatus).label,
    );
    expect(labels.join(' ')).not.toMatch(/notified|trouble/i);
  });

  it('stops polling only when nothing more can happen', () => {
    expect(isSettled('CANCELLED')).toBe(true);
    expect(isSettled('CLOSED')).toBe(true);
    expect(isSettled('MATCHING')).toBe(false);
    expect(isSettled('DECLINED')).toBe(false);
    expect(isSettled(undefined)).toBe(false);
  });
});

describe('isEditableStatus', () => {
  it('is true only while nobody has accepted', () => {
    const editable = (Object.keys(EXPECTED) as ServiceRequestStatus[]).filter(isEditableStatus);
    expect(editable).toEqual(['SUBMITTED', 'TRIAGED', 'MATCHING']);
  });
});
