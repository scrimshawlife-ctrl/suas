import type { CheckInCompleted } from './api';

export const NOT_A_DIAGNOSIS = 'This is not a diagnosis and does not contact emergency services.';

export interface ResultCopy {
  heading: string;
  body: string;
  /** Show the Harbor crisis panel above the words. */
  crisis: boolean;
}

/**
 * Plain, non-clinical words for the result. The level never appears on screen and there is
 * no score. Nothing here mentions alerts to trusted contacts: the API does not say whether
 * one was queued, so the screen stays silent about it.
 */
export function resultCopy(result: Pick<CheckInCompleted, 'support_signal'>): ResultCopy {
  switch (result.support_signal?.level) {
    case 'RED':
      return {
        heading: 'Your answers suggest you may need support right away.',
        body: 'If you are in danger or need urgent help, use the options above first. You can also ask SUAS for practical support.',
        crisis: true,
      };
    case 'ORANGE':
      return {
        heading: 'Your answers suggest you could use some support soon.',
        body: 'Your answers are saved. You can ask for help whenever you are ready.',
        crisis: false,
      };
    case 'YELLOW':
      return {
        heading: 'Thank you for checking in.',
        body: 'Your answers are saved. Some of them suggest things have been harder lately. Support is there if you want it.',
        crisis: false,
      };
    case 'GREEN':
      return {
        heading: 'Thank you for checking in.',
        body: 'Your answers are saved. Nothing in them points to a need for support right now. You can check in again any time.',
        crisis: false,
      };
    default:
      return {
        heading: 'Thank you for checking in.',
        body: 'Your answers are saved. Your result is not ready yet.',
        crisis: false,
      };
  }
}
