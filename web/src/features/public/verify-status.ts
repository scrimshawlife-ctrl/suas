import { hasApiCode, isApiError } from '../../api/errors';

/** What the Verify screen shows. */
export type VerifyView =
  'start' | 'pending' | 'verified' | 'not_confirmed' | 'unavailable' | 'revoked';

/**
 * Maps the API's check status (and a failed start) to a view. NOT_STARTED and unknown
 * values show the start button; a 503 ID_VERIFICATION_UNAVAILABLE is "unavailable".
 */
export function verifyView(status: string | undefined, startError?: unknown): VerifyView {
  if (hasApiCode(startError, 'ID_VERIFICATION_UNAVAILABLE')) return 'unavailable';
  switch (status) {
    case 'PENDING':
      return 'pending';
    case 'VERIFIED':
      return 'verified';
    case 'NOT_CONFIRMED':
      return 'not_confirmed';
    case 'UNAVAILABLE':
      return 'unavailable';
    case 'REVOKED':
      return 'revoked';
    default:
      return 'start';
  }
}

/** Zero based Stepper position: scan, selfie, in. */
export function verifyStep(view: VerifyView): number {
  if (view === 'verified') return 2;
  if (view === 'pending') return 1;
  return 0;
}

/** True when a start request failed for a reason other than the provider being unavailable. */
export function isOtherStartError(error: unknown): boolean {
  return isApiError(error) && !hasApiCode(error, 'ID_VERIFICATION_UNAVAILABLE');
}
