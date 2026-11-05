import type { ProgressStep } from '../../components/ProgressTrack';
import type { StatusKind } from '../../components/StatusChip';
import type { RequestCard } from './request-card';

/** Chip, headline and lead words for each of the seven QrfStates cards (board copy). */
export interface CardCopy {
  chip: { kind: StatusKind; label: string };
  headline: string;
  body: string;
}

export function cardCopy(card: RequestCard, counterpartName: string | null | undefined): CardCopy {
  switch (card) {
    case 'RECEIVED':
      return {
        chip: { kind: 'wait', label: 'Request received' },
        headline: 'Your request has been received.',
        body: 'SUAS will use the information you provided to identify available support. This does not mean that assistance has been confirmed.',
      };
    case 'MATCHING':
      return {
        chip: { kind: 'wait', label: 'Looking for a veteran' },
        headline: 'Looking for a veteran to take this.',
        body: "We'll show it here when someone is notified.",
      };
    case 'NOTIFIED':
      return {
        chip: { kind: 'info', label: 'A veteran was notified' },
        headline: 'A veteran has been notified.',
        body: "They haven't accepted yet.",
      };
    case 'ACCEPTED':
      return {
        chip: { kind: 'ok', label: 'A veteran accepted' },
        headline: counterpartName
          ? `${counterpartName} accepted your request.`
          : 'A veteran accepted your request.',
        body: 'A provider response is not the same as emergency dispatch. If the situation becomes life-threatening, call 911.',
      };
    case 'UNAVAILABLE':
      return {
        chip: { kind: 'off', label: 'No one available yet' },
        headline: 'We could not confirm support yet.',
        body: 'No participating provider has accepted this request. This does not mean that help is unavailable outside SUAS.',
      };
    case 'DEGRADED':
      return {
        chip: { kind: 'warn', label: 'Trouble coordinating' },
        headline: 'We are having trouble coordinating right now.',
        body: 'Your request is still recorded. This card updates when that changes.',
      };
    case 'CANCELLED':
      return {
        chip: { kind: 'off', label: 'Cancelled' },
        headline: 'Request cancelled.',
        body: 'Nothing else will be sent for this request.',
      };
  }
}

const TRACK_LABELS = [
  'Request received',
  'Looking for a veteran',
  'A veteran was notified',
  'A veteran accepted',
] as const;

/** Index of the current step on the track. Cards missing here (accepted, unavailable, degraded, cancelled) have none. */
const TRACK_PROGRESS: Partial<Record<RequestCard, number>> = {
  RECEIVED: 0,
  MATCHING: 1,
  NOTIFIED: 2,
};

export function hasProgressTrack(card: RequestCard): boolean {
  return TRACK_PROGRESS[card] !== undefined;
}

/**
 * The QrfActive 4-step track, for the cards where the request is still being looked after.
 * A step is "done" only up to the card's recorded state; the step after it is "now" and
 * everything later says "Not yet". The accepted card has no track: acceptance does not
 * record a notification, so "A veteran was notified" is never ticked from it. `received` is
 * the recorded request time ("7:42 PM"), the only timestamp the request read gives.
 */
export function progressSteps(card: RequestCard, received?: string): ProgressStep[] {
  const current = TRACK_PROGRESS[card];
  if (current === undefined) return [];
  return TRACK_LABELS.map((label, index) => {
    const state: ProgressStep['state'] =
      index < current ? 'done' : index === current ? 'now' : 'todo';
    const detail =
      index === 0 ? received : index === current ? 'Now' : index > current ? 'Not yet' : undefined;
    return detail === undefined ? { label, state } : { label, state, detail };
  });
}
