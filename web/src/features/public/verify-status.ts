import { isApiError, type ApiError } from '../../api/errors';

/** What the Verify screen shows. `start` and `not_found` show the form. */
export type VerifyView =
  'start' | 'not_found' | 'not_confirmed' | 'unavailable' | 'limit' | 'verified' | 'revoked';

/** A VA confirmation standing or result: GET /veterans/me `id_verification`, or a confirm answer. */
export interface VerifyResult {
  status: string;
  not_confirmed_reason: string | null;
}

/** The last answer in this visit: a settled result, or an error that changes what is offered. */
export type VerifyOutcome = { result: VerifyResult } | { error: ApiError };

const GATE_ERROR_VIEWS: Readonly<Record<string, VerifyView>> = {
  VERIFICATION_REVOKED: 'revoked',
  VERIFICATION_ATTEMPT_LIMIT: 'limit',
  ID_VERIFICATION_UNAVAILABLE: 'unavailable',
};

/** True for the confirm errors that get their own view (403, 429, 503); others stay on the form. */
export function isGateError(error: unknown): error is ApiError {
  return isApiError(error) && error.code in GATE_ERROR_VIEWS;
}

function resultView(result: VerifyResult): VerifyView | null {
  switch (result.status) {
    case 'VERIFIED':
      return 'verified';
    case 'REVOKED':
      return 'revoked';
    case 'NOT_CONFIRMED':
      return result.not_confirmed_reason === 'PERSON_NOT_FOUND' ? 'not_found' : 'not_confirmed';
    case 'UNAVAILABLE':
      return 'unavailable';
    default:
      return null;
  }
}

/**
 * Picks the view. VERIFIED and REVOKED standings always win. Otherwise this visit's last answer,
 * then the form if the person reopened it. A stored UNAVAILABLE (or PENDING, NOT_STARTED)
 * standing shows the form: an old outage says nothing about VA now.
 */
export function verifyView(
  standing: VerifyResult | undefined,
  outcome: VerifyOutcome | null,
  reopened: boolean,
): VerifyView {
  if (standing?.status === 'VERIFIED' || standing?.status === 'REVOKED') {
    return resultView(standing) ?? 'start';
  }
  if (outcome !== null) {
    if ('error' in outcome) return GATE_ERROR_VIEWS[outcome.error.code] ?? 'start';
    return resultView(outcome.result) ?? 'start';
  }
  if (reopened) return 'start';
  if (standing?.status === 'NOT_CONFIRMED') return resultView(standing) ?? 'start';
  return 'start';
}

/** "Try again after 3:45 PM tomorrow.", from a 429's Retry-After seconds. */
export function retryAfterText(seconds: number | null, now: Date = new Date()): string {
  if (seconds === null) return 'Try again later.';
  const minute = 60_000;
  const at = new Date(Math.ceil((now.getTime() + seconds * 1000) / minute) * minute);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `Try again after ${time} today.`;
  if (days === 1) return `Try again after ${time} tomorrow.`;
  const date = at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `Try again after ${time} on ${date}.`;
}
