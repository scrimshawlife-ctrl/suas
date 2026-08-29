/**
 * Authentication constants.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §3 — challenge TTL "remains an explicit documented
 *   constant (`DECISION_PENDING`, with any recommendation labeled `INFERRED`)".
 * - SUAS-specs AUTH.md §5 — idle/absolute session timeout "according to accepted
 *   constants".
 * - SUAS-specs SECURITY.md §2 — rate limits on auth challenges.
 *
 * Pilot-approved values and still-inferred values are gathered in one file so
 * enforcement is reviewable. Approval is limited to pilot implementation and
 * does not establish production readiness or measured compliance.
 */

/** Lifecycle label for a value this implementation chose, not one the release fixed. */
export const INFERRED = 'INFERRED' as const;
export const APPROVED_FOR_PILOT_IMPLEMENTATION = 'APPROVED_FOR_PILOT_IMPLEMENTATION' as const;
export type ConstantLifecycle = typeof INFERRED | typeof APPROVED_FOR_PILOT_IMPLEMENTATION;

export interface AuthConstant {
  readonly value: number;
  readonly lifecycle: ConstantLifecycle;
  readonly rationale: string;
}

function inferred(value: number, rationale: string): AuthConstant {
  return { value, lifecycle: INFERRED, rationale };
}

function pilotApproved(value: number, rationale: string): AuthConstant {
  return { value, lifecycle: APPROVED_FOR_PILOT_IMPLEMENTATION, rationale };
}

/** Pilot decision: participant magic links are single-use and expire after 15 minutes. */
export const CHALLENGE_TTL_SECONDS = pilotApproved(
  900,
  'Approved pilot magic-link expiration. The same bounded challenge primitive is used for OTP.',
);

/** AUTH.md §3: challenges are rate-limited and attempt-bounded. */
export const CHALLENGE_MAX_ATTEMPTS = inferred(
  5,
  'Bounds brute force against a 6-digit OTP while tolerating mistyping.',
);

/** Pilot decision: no more than three challenge issuances per account in 15 minutes. */
export const CHALLENGE_ISSUE_LIMIT = pilotApproved(
  3,
  'Approved pilot account-level issuance limit. The separate IP limit still requires request-IP plumbing.',
);

export const CHALLENGE_ISSUE_WINDOW_SECONDS = inferred(
  900,
  'Fifteen-minute window pairs with the issue limit above.',
);

/** Pilot decision: failed authentication is limited to five attempts per 15 minutes. */
export const CHALLENGE_VERIFY_LIMIT = pilotApproved(
  5,
  'Approved pilot destination-level verification limit across challenge rotation.',
);

export const CHALLENGE_VERIFY_WINDOW_SECONDS = inferred(
  900,
  'Matches the issue window for operational simplicity.',
);

/** AUTH.md §5: absolute session lifetime. */
export const SESSION_ABSOLUTE_TTL_SECONDS = inferred(
  60 * 60 * 12,
  'Twelve hours bounds a stolen credential without forcing a re-login mid-shift ' +
    'for a responder. AUTH.md §5 defers to "accepted constants" that do not exist yet.',
);

/** AUTH.md §5: idle timeout. */
export const SESSION_IDLE_TTL_SECONDS = inferred(
  60 * 60 * 2,
  'Two idle hours ends an abandoned session well inside the absolute lifetime.',
);

/**
 * AUTH.md §4: MFA is completed before privileged elevation. Elevation is
 * deliberately shorter than the session so a privileged window does not last as
 * long as the login.
 */
export const MFA_ELEVATION_TTL_SECONDS = inferred(
  60 * 15,
  'Fifteen minutes keeps privileged authority close to the act of proving it.',
);

/** Length of the numeric code delivered for OTP methods. */
export const OTP_CODE_DIGITS = inferred(6, 'Standard OTP length; paired with attempt bounds.');

/** All authentication constants, for the build-info/admin surface and review. */
export const AUTH_CONSTANTS: Readonly<Record<string, AuthConstant>> = {
  CHALLENGE_TTL_SECONDS,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_ISSUE_LIMIT,
  CHALLENGE_ISSUE_WINDOW_SECONDS,
  CHALLENGE_VERIFY_LIMIT,
  CHALLENGE_VERIFY_WINDOW_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  MFA_ELEVATION_TTL_SECONDS,
  OTP_CODE_DIGITS,
};

/** @deprecated Use AUTH_CONSTANTS, which preserves each value's lifecycle. */
export const INFERRED_AUTH_CONSTANTS = AUTH_CONSTANTS;
