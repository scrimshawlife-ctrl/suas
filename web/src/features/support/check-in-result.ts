import type { CheckInCompleted } from './api';

export const NOT_A_DIAGNOSIS = 'This is not a diagnosis and does not contact emergency services.';

/** Shown when a Check-In ended INCOMPLETE: the server refuses more answers, so start again. */
export const INCOMPLETE_TEXT = 'We could not finish this Check-In. You can start a new one.';

/**
 * Shown when the server refuses an answer or completion with ILLEGAL_TRANSITION: the Check-In
 * is past its 24-hour window or already settled (R8.10), so retrying can never work.
 */
export const EXPIRED_TEXT =
  'This Check-In has expired and can no longer be finished. You can start a new one.';

export interface ResultCopy {
  heading: string;
  body: string;
  /** Show the Harbor crisis panel after the neutral lines. */
  crisis: boolean;
}

/**
 * The result says nothing about the person. Every level gets the same two neutral lines; a
 * RED signal only adds the crisis panel (D-012 wording, verbatim, in CrisisPanel). The level,
 * a score, an interpretation of the answers and any word about alerts to trusted contacts
 * never appear (AGENTS.md rules 14 and 15).
 */
export function resultCopy(result: Pick<CheckInCompleted, 'support_signal'>): ResultCopy {
  return {
    heading: 'Thank you for checking in.',
    body: 'Your answers are saved.',
    crisis: result.support_signal?.level === 'RED',
  };
}
