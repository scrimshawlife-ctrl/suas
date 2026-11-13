import { GATE_CODES, isApiError, isConnectionError } from '../../api/errors';
import { paths } from '../../app/paths';

/** Where a gate error sends the person. `undefined` means it is not a gate error. */
export function gateRedirect(error: unknown): string | undefined {
  if (!isApiError(error)) return undefined;
  if (error.code === GATE_CODES.verificationRequired) return paths.verify;
  if (error.code === GATE_CODES.countyRequired) return paths.welcome;
  return undefined;
}

/** Plain words for a failed write. Never the raw server message, never red. */
export function requestErrorMessage(error: unknown): string {
  if (!isApiError(error) || isConnectionError(error)) {
    return 'That did not go through. Check your connection and try again.';
  }
  if (error.status === 403) {
    return error.code === GATE_CODES.forbidden
      ? 'Only the person who asked for help can do that.'
      : 'You do not have access to that.';
  }
  if (error.status === 404) return 'We could not find that request.';
  if (error.status === 409) {
    return 'This changed while you were looking. Reload the page to see where it stands.';
  }
  if (error.status === 413) return 'What you entered is too long. Shorten it and try again.';
  if (error.status === 422 || error.status === 400) {
    return 'Some of what you entered needs another look.';
  }
  if (error.status === 429) return 'Too many tries. Wait a moment and try again.';
  if (error.status >= 500) return 'Something went wrong on our side. Try again.';
  return 'That did not go through. Try again.';
}
