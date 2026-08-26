/**
 * HTML Check-In composition and truthful result copy.
 *
 * These are not new domain verbs. Start/resume calls `findInProgressCheckIn`
 * then `startCheckIn`. Answers and complete use `saveResponse` and
 * `completeCheckIn` from the route, the same functions the JSON API uses.
 *
 * Spec citations:
 * - SUAS-specs CHECKINS.md §1 (input artifact), §4 (states), §4.1 (incomplete),
 *   §4.3 (correction is a new Check-In), §6 (completion requests scoring),
 *   §8 (veteran owns their Check-In)
 * - SUAS-specs API.md §4 / §8 (session; start/response/complete)
 * - SUAS-specs SAFETY.md §3.2 (settled effective RED opens or updates a
 *   Support Case; non-RED is a no-op)
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_SUPPORT_SIGNAL_MODE=disabled|fixture`)
 * - SUAS-specs EVENT_MODEL.md §3.1 (CHECKIN_COMPLETED is not a settled signal)
 */

import type { Pool } from 'pg';
import type { SupportSignalMode } from '../config/index.js';
import { withTransaction } from '../db/index.js';
import {
  findInProgressCheckIn,
  startCheckIn,
  type CheckIn,
  type CheckInStatus,
  type SignalLevel,
} from '../signals/index.js';
import type { CheckInResultViewModel } from './view-models.js';

export interface StartOrResumeCheckInInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
}

export interface StartOrResumeCheckInResult {
  readonly checkIn: CheckIn;
  /** False when an in-flight Check-In already existed and was resumed. */
  readonly created: boolean;
}

/**
 * Resume the veteran's in-flight Check-In, or start one on the published version.
 *
 * CHECKINS.md does not require a second in-flight Check-In. Concurrent POSTs
 * serialize on a tenant+veteran advisory lock so HTML start is not a silent
 * duplicate of `startCheckIn`.
 */
export async function startOrResumeCheckIn(
  pool: Pool,
  input: StartOrResumeCheckInInput,
): Promise<StartOrResumeCheckInResult> {
  return withTransaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [
      `check-in:${input.tenantId}`,
      input.veteranUserId,
    ]);
    const existing = await findInProgressCheckIn(tx, input.tenantId, input.veteranUserId);
    if (existing !== undefined) {
      return { checkIn: existing, created: false };
    }
    return { checkIn: await startCheckIn(tx, input), created: true };
  });
}

export interface PresentCheckInResultInput {
  readonly status: CheckInStatus;
  readonly supportSignalMode: SupportSignalMode;
  readonly signalLevel?: SignalLevel;
  readonly supportCaseOpened: boolean;
  readonly alreadyCompleted?: boolean;
}

const FIXTURE_DISCLAIMER =
  'This fixture Support Signal result is not a clinical score and is not a diagnosis.';
const DISABLED_DISCLAIMER =
  'Support Signal scoring is disabled in this environment. That is not a clinical score and is not a diagnosis.';
const NO_EMERGENCY = 'SUAS did not contact emergency services.';

/**
 * Veteran-facing result copy. Honest about fixture/disabled mode.
 *
 * Never claims 911 dispatch, diagnosis, or suicide prediction. SAFETY.md §3.2
 * permits saying a Support Case was opened when a settled RED did that.
 */
export function presentCheckInResult(input: PresentCheckInResultInput): CheckInResultViewModel {
  const modeNote =
    input.supportSignalMode === 'disabled' ? DISABLED_DISCLAIMER : FIXTURE_DISCLAIMER;
  const replay =
    input.alreadyCompleted === true ? ' Submitting complete again made no change.' : '';

  if (input.status === 'INCOMPLETE') {
    return {
      statusLabel: 'INCOMPLETE',
      headline: 'This Check-In is incomplete.',
      detail:
        'Required answers were missing. No Support Signal was computed from this Check-In.' +
        replay,
    };
  }

  if (input.status === 'ABANDONED') {
    return {
      statusLabel: 'ABANDONED',
      headline: 'This Check-In was abandoned.',
      detail: 'No Support Signal was computed from this Check-In.',
    };
  }

  if (input.status !== 'COMPLETED') {
    return {
      statusLabel: input.status,
      headline: 'This Check-In is still in progress.',
      detail: 'Answer the remaining questions, or complete it when you are ready.',
    };
  }

  if (input.signalLevel === undefined) {
    return {
      statusLabel: 'COMPLETED',
      headline: 'Check-In complete.',
      detail:
        'A Support Signal has not settled. Completing a Check-In requests scoring; ' +
        'it does not mean a signal has already settled. ' +
        modeNote +
        ' ' +
        NO_EMERGENCY +
        replay,
    };
  }

  const levelLine = `Recorded Support Signal level: ${input.signalLevel}.`;
  const caseLine =
    input.signalLevel === 'RED' && input.supportCaseOpened
      ? ' A Support Case was opened.'
      : input.signalLevel === 'RED'
        ? ''
        : '';

  return {
    statusLabel: 'COMPLETED',
    headline: 'Check-In complete.',
    detail: `${levelLine}${caseLine} ${modeNote} ${NO_EMERGENCY}${replay}`,
  };
}
