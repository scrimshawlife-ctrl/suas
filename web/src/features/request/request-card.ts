import type { ServiceRequestStatus } from '../../api/types';

/** The seven cards on the QrfStates board. */
export type RequestCard =
  'RECEIVED' | 'MATCHING' | 'NOTIFIED' | 'ACCEPTED' | 'UNAVAILABLE' | 'DEGRADED' | 'CANCELLED';

/** The slice of `me.active_qrf` the mapping reads. */
export interface ActiveQrfFact {
  service_request_id: string;
  state: string;
  cancellable: boolean;
}

const FROM_QRF_STATE: Record<string, RequestCard> = {
  REQUESTED: 'RECEIVED',
  SEARCHING: 'MATCHING',
  RESPONDER_NOTIFIED: 'NOTIFIED',
  RESPONDER_ACCEPTED: 'ACCEPTED',
  NO_RESPONDER_CURRENTLY_AVAILABLE: 'UNAVAILABLE',
  DEGRADED: 'DEGRADED',
  CANCELLED: 'CANCELLED',
};

/** Acceptance is recorded from ACCEPTED onward (src/ui/qrf.ts, ACCEPTANCE_RECORDED). */
const ACCEPTANCE_RECORDED: readonly ServiceRequestStatus[] = [
  'ACCEPTED',
  'IN_PROGRESS',
  'FULFILLED',
  'CONFIRMED',
  'CLOSED',
];

/** Statuses with a CANCEL edge (src/coordination/request-transitions.ts). */
const CANCELLABLE: readonly ServiceRequestStatus[] = [
  'CREATED',
  'SUBMITTED',
  'TRIAGED',
  'MATCHING',
  'ASSIGNED',
  'ACCEPTED',
  'IN_PROGRESS',
];

/** Polling stops once nothing more can happen on the requester's side. */
const SETTLED: readonly ServiceRequestStatus[] = [
  'CONFIRMED',
  'CLOSED',
  'CANCELLED',
  'EXPIRED',
  'UNFULFILLABLE',
];

export function cardFromQrfState(state: string): RequestCard | undefined {
  return FROM_QRF_STATE[state];
}

/**
 * The card a status alone supports; mirrors `presentQrfState` in src/ui/qrf.ts without the
 * two facts only the server can read. So NOTIFIED and DEGRADED never come from here: a
 * recorded notification delivery is the only thing that earns "A veteran was notified".
 */
export function cardFromStatus(status: ServiceRequestStatus): RequestCard {
  if (status === 'CANCELLED') return 'CANCELLED';
  if (ACCEPTANCE_RECORDED.includes(status)) return 'ACCEPTED';
  if (status === 'UNFULFILLABLE' || status === 'EXPIRED' || status === 'DECLINED') {
    return 'UNAVAILABLE';
  }
  if (status === 'CREATED' || status === 'SUBMITTED') return 'RECEIVED';
  return 'MATCHING';
}

/**
 * The card to show. `me.active_qrf.state` is the authority for the request it names, since
 * only the server sees notification delivery. The one exception is a fresher request read
 * that already shows cancellation or acceptance: the server ranks those above every other
 * fact, so a lagging `me` must not hold the card at an earlier state.
 */
export function resolveRequestCard(input: {
  requestId: string;
  status: ServiceRequestStatus;
  activeQrf: ActiveQrfFact | null | undefined;
}): RequestCard {
  const fromStatus = cardFromStatus(input.status);
  const active = input.activeQrf;
  if (active?.service_request_id !== input.requestId) return fromStatus;
  const fromQrf = cardFromQrfState(active.state);
  if (fromQrf === undefined) return fromStatus;
  if (fromStatus === 'CANCELLED' || fromStatus === 'ACCEPTED') return fromStatus;
  return fromQrf;
}

export function isCancellableStatus(status: ServiceRequestStatus): boolean {
  return CANCELLABLE.includes(status);
}

/** Cancel is offered when the status has a CANCEL edge and, for the active QRF, the server agrees. */
export function canCancel(input: {
  requestId: string;
  status: ServiceRequestStatus;
  activeQrf: ActiveQrfFact | null | undefined;
}): boolean {
  if (!isCancellableStatus(input.status)) return false;
  const active = input.activeQrf;
  return active?.service_request_id === input.requestId ? active.cancellable : true;
}

export function isSettled(status: ServiceRequestStatus | undefined): boolean {
  return status !== undefined && SETTLED.includes(status);
}

/** Short chip for a row in "Your requests". */
export interface ListChip {
  kind: 'wait' | 'info' | 'ok' | 'off';
  label: string;
}

export function listChipForStatus(status: ServiceRequestStatus): ListChip {
  if (status === 'CONFIRMED' || status === 'CLOSED') return { kind: 'ok', label: 'Done' };
  if (status === 'FULFILLED') return { kind: 'info', label: 'Marked done' };
  const card = cardFromStatus(status);
  switch (card) {
    case 'ACCEPTED':
      return { kind: 'ok', label: 'Accepted' };
    case 'UNAVAILABLE':
      return { kind: 'off', label: 'No one yet' };
    case 'CANCELLED':
      return { kind: 'off', label: 'Cancelled' };
    case 'RECEIVED':
      return { kind: 'wait', label: 'Received' };
    default:
      return { kind: 'wait', label: 'Looking' };
  }
}
