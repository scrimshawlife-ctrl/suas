import { hasApiCode, isApiError, isMissingRecord } from '../../api/errors';
import type { Schemas, ServiceRequestStatus } from '../../api/types';
import type { StatusKind } from '../../components/StatusChip';

export type ContactChannel = Schemas['LogContactAttemptRequest']['channel'];
export type ContactOutcome = Schemas['ContactAttempt']['outcome'];
export type ContactAttempt = Schemas['ContactAttempt'];

/** Channel pills, in the order and words of the Case board. */
export const CHANNEL_OPTIONS: readonly { value: ContactChannel; label: string }[] = [
  { value: 'PHONE', label: 'Phone' },
  { value: 'SMS', label: 'Text' },
  { value: 'IN_APP', label: 'In the app' },
  { value: 'EMAIL', label: 'Email' },
];

/** Outcome pills, in the order and words of the Case board. */
export const OUTCOME_OPTIONS: readonly { value: ContactOutcome; label: string }[] = [
  { value: 'REACHED', label: 'Reached them' },
  { value: 'NO_ANSWER', label: 'No answer' },
  { value: 'LEFT_MESSAGE', label: 'Left a message' },
  { value: 'DECLINED', label: 'They declined' },
  { value: 'UNABLE', label: "Couldn't try" },
  { value: 'PENDING', label: 'Waiting to hear' },
];

export type ContactSave =
  | { route: 'log-contact-attempt'; body: { channel: ContactChannel; outcome: 'PENDING' } }
  | {
      route: 'complete-contact';
      body: { channel: ContactChannel; outcome: Exclude<ContactOutcome, 'PENDING'> };
    };

/**
 * src/http/routes/contact-log.ts: `log-contact-attempt` accepts only the PENDING outcome
 * ("waiting to hear"); `complete-contact` accepts the five settled outcomes.
 */
export function contactSave(channel: ContactChannel, outcome: ContactOutcome): ContactSave {
  if (outcome === 'PENDING') {
    return { route: 'log-contact-attempt', body: { channel, outcome } };
  }
  return { route: 'complete-contact', body: { channel, outcome } };
}

const CHANNEL_HISTORY: Record<ContactChannel, string> = {
  PHONE: 'Phone call',
  SMS: 'Text message',
  IN_APP: 'Message in the app',
  EMAIL: 'Email',
};

/** "Phone call, reached Marcus". `name` is the requester's first name. */
export function attemptLabel(attempt: ContactAttempt, name: string): string {
  const who = name || 'them';
  const outcome: Record<ContactOutcome, string> = {
    REACHED: `reached ${who}`,
    NO_ANSWER: 'no answer',
    LEFT_MESSAGE: 'left a message',
    DECLINED: `${who} declined`,
    UNABLE: "couldn't try",
    PENDING: 'waiting to hear',
  };
  return `${CHANNEL_HISTORY[attempt.channel]}, ${outcome[attempt.outcome]}`;
}

/** Oldest first, as the History card is drawn. */
export function attemptsOldestFirst(attempts: readonly ContactAttempt[]): ContactAttempt[] {
  return [...attempts].sort((a, b) => Date.parse(a.attempted_at) - Date.parse(b.attempted_at));
}

export interface NextStep {
  command: 'ACCEPT' | 'START' | 'FULFILL' | 'CLOSE';
  label: string;
}

/**
 * The one legal forward step the accepter may run (src/coordination/request-transitions.ts,
 * DISPATCH.md §4, §14.2: the accepter closes a CONFIRMED request). CONFIRM and CANCEL belong
 * to the requester; the earlier system steps (TRIAGE, START_MATCHING, ASSIGN) are not offered.
 */
export function nextStep(status: ServiceRequestStatus): NextStep | null {
  switch (status) {
    case 'ASSIGNED':
      return { command: 'ACCEPT', label: "I'll take this one" };
    case 'ACCEPTED':
      return { command: 'START', label: "I've started helping" };
    case 'IN_PROGRESS':
      return { command: 'FULFILL', label: 'Mark as done' };
    case 'CONFIRMED':
      return { command: 'CLOSE', label: 'Close this request' };
    default:
      return null;
  }
}

/** The server accepts RELEASE only from ACCEPTED, and only for the accepter (the case page's viewer). */
export function canRelease(status: ServiceRequestStatus): boolean {
  return status === 'ACCEPTED';
}

/** Matches `reason` max(512) in src/http/routes/service-requests.ts. */
export const RELEASE_REASON_MAX = 512;

/** Plain-word status for the chips and the progress line. */
export function statusLabel(status: ServiceRequestStatus): string {
  switch (status) {
    case 'CREATED':
      return 'Not sent yet';
    case 'SUBMITTED':
    case 'TRIAGED':
    case 'MATCHING':
    case 'ASSIGNED':
      return 'Taken, not started';
    case 'ACCEPTED':
      return 'Ready to start';
    case 'IN_PROGRESS':
      return 'In progress';
    case 'FULFILLED':
      return 'Marked as done';
    case 'CONFIRMED':
      return 'Confirmed';
    case 'CLOSED':
      return 'Closed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'DECLINED':
      return 'Declined';
    case 'EXPIRED':
      return 'Expired';
    case 'UNFULFILLABLE':
      return "Couldn't be filled";
    case 'ESCALATED':
      return 'Under review';
  }
}

export function statusKind(status: ServiceRequestStatus): StatusKind {
  switch (status) {
    case 'IN_PROGRESS':
    case 'FULFILLED':
    case 'CONFIRMED':
      return 'ok';
    case 'ACCEPTED':
      return 'info';
    case 'CLOSED':
    case 'CANCELLED':
    case 'EXPIRED':
    case 'UNFULFILLABLE':
    case 'DECLINED':
      return 'off';
    default:
      return 'wait';
  }
}

export const NOT_FOUND_MESSAGE = "We couldn't find that request.";

/**
 * The helper view is a 404 for anyone who is not the accepter (a 403 on the contact log too);
 * a malformed id in the address (400) is just as missing.
 */
export function isNotHelperError(error: unknown): boolean {
  return isMissingRecord(error) || (isApiError(error) && error.status === 403);
}

/** Plain words for a failed progress command. */
export function commandErrorMessage(error: unknown): string {
  if (hasApiCode(error, 'ILLEGAL_TRANSITION') || hasApiCode(error, 'STALE_STATE')) {
    return "That step isn't available right now. We refreshed the request.";
  }
  if (isApiError(error) && error.status === 403) {
    return 'Only the person who took this request can do that.';
  }
  return 'That did not go through. Try again.';
}

/** "Tue 7:42 PM" within the last week, otherwise "Nov 3, 7:42 PM". */
export function formatWhen(iso: string, now: number = Date.now()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const recent = now - date.getTime() < 6 * 24 * 60 * 60 * 1000 && date.getTime() <= now;
  if (recent) return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
}
