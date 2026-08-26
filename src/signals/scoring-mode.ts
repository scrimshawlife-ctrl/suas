/**
 * Process-scoped Support Signal operating mode.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_SUPPORT_SIGNAL_MODE=disabled|fixture`)
 *
 * Kept in its own module so both `computeSignal` and the released `sv-001`
 * engine (`computeSv001` / `SV_001_ENGINE.compute`) share one gate without a
 * circular import between engine.ts and sv-001.ts.
 */

import type { SupportSignalMode } from '../config/index.js';

let configuredSupportSignalMode: SupportSignalMode | undefined;

export function configureSupportSignalScoring(mode: SupportSignalMode): void {
  configuredSupportSignalMode = mode;
}

export function clearSupportSignalScoringMode(): void {
  configuredSupportSignalMode = undefined;
}

export function currentSupportSignalMode(
  override?: SupportSignalMode,
): SupportSignalMode | undefined {
  return override ?? configuredSupportSignalMode;
}

/**
 * Refuse when mode is `disabled`. Unset mode allows pure algorithm tests
 * (golden vectors); application startup always configures from env.
 */
export function assertSupportSignalScoringEnabled(override?: SupportSignalMode): void {
  const mode = currentSupportSignalMode(override);
  if (mode === 'disabled') {
    // Lazy import-free error construction: callers map this to SignalScoringUnavailableError.
    throw new SupportSignalModeDisabledError();
  }
}

export class SupportSignalModeDisabledError extends Error {
  readonly code = 'SIGNAL_SCORING_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor() {
    super(
      'SUAS_SUPPORT_SIGNAL_MODE=disabled (ENVIRONMENT.md §3; scoring is not available on any application path)',
    );
    this.name = 'SupportSignalModeDisabledError';
  }
}
