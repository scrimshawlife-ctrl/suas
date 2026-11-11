import { isApiError, type ApiError } from '../../api/errors';

/**
 * What the Verify screen shows (VA_CONFIRMATION_FLOW §4.4). `start`, `not_found`,
 * `request_invalid` and `name_mismatch` show the notice and the form; `self_attest` is the
 * "Tell us you served" step; `verified` and `attested` are the two ways the gate opens.
 */
export type VerifyView =
  | 'start'
  | 'not_found'
  | 'not_confirmed'
  | 'request_invalid'
  | 'unavailable'
  | 'disabled'
  | 'limit'
  | 'name_mismatch'
  | 'identity_taken'
  | 'self_attest'
  | 'verified'
  | 'attested'
  | 'revoked';

/** A standing (GET /veterans/me `id_verification`) or a confirm / self-attest answer. */
export interface VerifyResult {
  method?: string;
  status: string;
  not_confirmed_reason: string | null;
  /** Why VA gave no answer; REQUEST_INVALID (VA refused our request) is correctable. */
  failure_class?: string | null;
}

/** The last answer in this visit: a settled result, or an error that changes what is offered. */
export type VerifyOutcome = { result: VerifyResult } | { error: ApiError };

/** Where the person chose to go in this visit, after an answer: back to the form, or self-attest. */
export type VerifyChoice = 'form' | 'self_attest' | null;

const GATE_ERROR_VIEWS: Readonly<Record<string, VerifyView>> = {
  VERIFICATION_REVOKED: 'revoked',
  VERIFICATION_ATTEMPT_LIMIT: 'limit',
  // 503 is only sent when VA confirmation is turned off; a VA outage is a 200 UNAVAILABLE.
  ID_VERIFICATION_UNAVAILABLE: 'disabled',
  VA_NAME_MISMATCH: 'name_mismatch',
  VA_IDENTITY_ALREADY_VERIFIED: 'identity_taken',
};

/** Views that show the notice and the form below their message. */
export const FORM_VIEWS: ReadonlySet<VerifyView> = new Set([
  'start',
  'not_found',
  'request_invalid',
  'name_mismatch',
]);

/** True for the errors that get their own view (403, 409, 429, 503); others stay on the form. */
export function isGateError(error: unknown): error is ApiError {
  return isApiError(error) && error.code in GATE_ERROR_VIEWS;
}

function resultView(result: VerifyResult): VerifyView | null {
  switch (result.status) {
    case 'VERIFIED':
      // Only a VA answer may say "VA confirmed"; self-attestation (and later review) does not.
      return result.method === undefined || result.method === 'VA_VETERAN_STATUS'
        ? 'verified'
        : 'attested';
    case 'REVOKED':
      return 'revoked';
    case 'NOT_CONFIRMED':
      return result.not_confirmed_reason === 'PERSON_NOT_FOUND' ? 'not_found' : 'not_confirmed';
    case 'UNAVAILABLE':
      return result.failure_class === 'REQUEST_INVALID' ? 'request_invalid' : 'unavailable';
    default:
      return null;
  }
}

/**
 * Picks the view. VERIFIED and REVOKED standings always win. Otherwise the person's choice in
 * this visit, then this visit's last answer. A stored UNAVAILABLE (or PENDING, NOT_STARTED)
 * standing shows the form: an old outage says nothing about VA now.
 */
export function verifyView(
  standing: VerifyResult | undefined,
  outcome: VerifyOutcome | null,
  choice: VerifyChoice,
): VerifyView {
  if (standing?.status === 'VERIFIED' || standing?.status === 'REVOKED') {
    return resultView(standing) ?? 'start';
  }
  if (outcome !== null && 'error' in outcome && outcome.error.code === 'VERIFICATION_REVOKED') {
    return 'revoked';
  }
  if (choice === 'self_attest') return 'self_attest';
  if (outcome !== null) {
    if ('error' in outcome) return GATE_ERROR_VIEWS[outcome.error.code] ?? 'start';
    return resultView(outcome.result) ?? 'start';
  }
  if (choice === 'form') return 'start';
  if (standing?.status === 'NOT_CONFIRMED') return resultView(standing) ?? 'start';
  return 'start';
}

/**
 * When VA may be tried again, from a 429's Retry-After seconds: "You can try VA again after
 * 3:45 PM tomorrow." Never says "today": the limit is a rolling 24 hours, not a calendar day.
 */
export function retryAfterText(seconds: number | null, now: Date = new Date()): string {
  if (seconds === null) return 'You can try VA again later.';
  const minute = 60_000;
  const at = new Date(Math.ceil((now.getTime() + seconds * 1000) / minute) * minute);
  const time = at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const days = Math.round(
    (new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000,
  );
  if (days === 0) return `You can try VA again after ${time}.`;
  if (days === 1) return `You can try VA again after ${time} tomorrow.`;
  const date = at.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  return `You can try VA again after ${time} on ${date}.`;
}
