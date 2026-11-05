import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';

export const MFA_UNAVAILABLE_TEXT = 'Admin sign-in is not available in this environment.';
export const MFA_WRONG_RESPONSE_TEXT =
  'That response did not match. Each check works once, so start a new check and try again.';
export const MFA_GENERIC_TEXT = 'The check did not go through. Try again.';

/** Plain words for a failed MFA call. Never shows server text for a 5xx. */
export function mfaErrorMessage(error: unknown): string {
  if (isApiError(error)) {
    // 404: the API build has no MFA routes, which is the same "not available" to the person.
    if (error.code === 'MFA_UNAVAILABLE' || error.status === 503 || error.status === 404)
      return MFA_UNAVAILABLE_TEXT;
    if (error.status === 401 || error.status === 400) return MFA_WRONG_RESPONSE_TEXT;
  }
  return MFA_GENERIC_TEXT;
}

/** True when the failure means no check can ever work here, so a retry button would mislead. */
export function mfaIsUnavailable(error: unknown): boolean {
  return mfaErrorMessage(error) === MFA_UNAVAILABLE_TEXT;
}

/**
 * Where to go after the check: the admin page the guard sent the person from, else the
 * overview. Anything outside /admin (or the step-up page itself) is ignored.
 */
export function mfaReturnPath(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  if (typeof from !== 'string') return paths.admin;
  const path = from.split(/[?#]/)[0] ?? '';
  const inAdmin = path === paths.admin || path.startsWith(`${paths.admin}/`);
  return inAdmin && path !== paths.adminMfa ? from : paths.admin;
}

/** Dev-build hint: the test factor accepts "ok-" plus the challenge id (src/auth/mfa.ts). */
export function testFactorHint(challengeId: string): string {
  return `Dev build only. The test check accepts "ok-" followed by the check id. This check id is ${challengeId}.`;
}
