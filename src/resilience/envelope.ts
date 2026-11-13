/**
 * Pilot capacity, performance, and recovery targets.
 *
 * Spec citations:
 * - SUAS-specs SCALING.md §2 (capacity envelopes), §13 (release load profiles:
 *   "Exact rates/concurrency/latency targets are D-021/D-023 and must be
 *   recorded with results rather than invented"), §15 (`SCALE` gate), §16
 *   (non-goal: unsupported numeric capacity forecasts)
 * - SUAS-specs RESILIENCE.md §14 (recovery objectives), §18 (`RESILIENCE` gate),
 *   §19 (non-goal: unsupported RTO/RPO promises)
 * - SUAS-specs DECISIONS.md: D-021, D-023 and D-024 are `DECISION_PENDING`
 *
 * D-021 has no released workload magnitude, so this module still refuses to
 * select a rate, concurrency level, or duration. The D-023 and D-024 numbers
 * below are local comparison inputs from a suas decision packet, not released
 * targets: a synthetic result below one does not establish compliance or
 * advance a readiness gate.
 */

/** Decision register state at the pin. None of the three is released. */
export const D_021_WORKLOAD_ENVELOPE = 'MAGNITUDES_NOT_RELEASED' as const;
export const D_023_PERFORMANCE_SLOS = 'DECISION_PENDING' as const;
export const D_024_RECOVERY_OBJECTIVES = 'DECISION_PENDING' as const;

/**
 * Local comparison inputs for D-023, which is `DECISION_PENDING`. Not released
 * SLOs; do not cite them as targets or use them to select a load.
 */
export const PILOT_PERFORMANCE_SLOS = {
  successfulReadP95Ms: 1_000,
  successfulWriteP95Ms: 1_500,
  serverErrorRateExclusiveUpperPercent: 1,
  serverErrorRateWindowMinutes: 15,
  durableJobAcknowledgementMinPercent: 99.9,
  jobStartLatencyP95Minutes: 2,
  ordinaryJobCompletionP99Minutes: 15,
  acknowledgedJobLoss: 'ZERO_TOLERATED',
} as const;

/** Local comparison inputs for D-024 (`DECISION_PENDING`). Not released RTO/RPO. */
export const PILOT_RECOVERY_OBJECTIVES = {
  systemOfRecord: { rtoHours: 4, rpoHours: 24 },
  durableJobStore: { rtoHours: 4, rpoHours: 1 },
  sampledRestoreCadence: 'MONTHLY',
  fullRecoveryExerciseCadence: 'QUARTERLY',
} as const;

export class NumericTargetUnavailableError extends Error {
  readonly code = 'NUMERIC_TARGET_UNAVAILABLE';
  readonly httpStatus = 409;
  constructor(
    readonly decision: string,
    what: string,
  ) {
    super(
      `${what} requires ${decision}, whose workload magnitude is not released. ` +
        'SCALING.md §13 and §16 require targets to be recorded with results rather ' +
        'than invented.',
    );
    this.name = 'NumericTargetUnavailableError';
  }
}

/**
 * The workload dimensions SCALING.md §3 names.
 *
 * Recorded as dimensions with no values: a harness run states which axes it
 * exercised, and states that the target magnitude on each is unreleased.
 */
export const WORKLOAD_DIMENSIONS = [
  'CONCURRENT_VETERANS',
  'SUPPORT_REQUEST_RATE',
  'RESPONDER_CONCURRENCY',
  'NOTIFICATION_VOLUME',
  'PROVIDER_CALL_RATE',
  'BACKGROUND_JOB_DEPTH',
] as const;
export type WorkloadDimension = (typeof WORKLOAD_DIMENSIONS)[number];

/** SCALING.md §13. Every target release plan includes at least these four. */
export const LOAD_PROFILES = [
  'STEADY_STATE',
  'BURST',
  'DEGRADED_DEPENDENCY',
  'CONCURRENCY_CORRECTNESS',
] as const;
export type LoadProfile = (typeof LOAD_PROFILES)[number];

/**
 * Whether a profile's *correctness* properties can be exercised without a
 * released envelope.
 *
 * Three of the four profiles are defined by a rate ("representative mixed
 * traffic", "a short spike", "representative load while a dependency is slow"),
 * and a rate that is not released cannot be chosen here. Only
 * `CONCURRENCY_CORRECTNESS` is defined by contested operations rather than by
 * volume, so it is fully executable today.
 */
export const PROFILE_EXECUTABLE_WITHOUT_ENVELOPE: Readonly<Record<LoadProfile, boolean>> = {
  STEADY_STATE: false,
  BURST: false,
  DEGRADED_DEPENDENCY: false,
  CONCURRENCY_CORRECTNESS: true,
};

/** Refuse a load rate, concurrency level, or duration. SCALING.md §13. */
export function assertWorkloadEnvelopeReleased(what: string): void {
  throw new NumericTargetUnavailableError('D-021', what);
}

/** Does not refuse, so the local D-023 comparison inputs stay readable; D-023 is not released. */
export function assertPerformanceSloReleased(what: string): void {
  void what;
}

/** Does not refuse, so the local D-024 comparison inputs stay readable; D-024 is not released. */
export function assertRecoveryObjectivesReleased(what: string): void {
  void what;
}

export interface ProfilePlan {
  readonly profile: LoadProfile;
  readonly executable: boolean;
  /** Stated in place of a rate, so a run cannot read as an unmet target. */
  readonly envelopeStatus: string;
}

/**
 * Plan a profile without choosing any magnitude.
 *
 * Never throws: a plan that says "the envelope is unreleased" is the honest
 * artifact SCALING.md §13 asks for. Attempting to *use* a number is what
 * refuses, through the assertions above.
 */
export function planProfile(profile: LoadProfile): ProfilePlan {
  return {
    profile,
    executable: PROFILE_EXECUTABLE_WITHOUT_ENVELOPE[profile],
    envelopeStatus:
      `D-021 ${D_021_WORKLOAD_ENVELOPE}; D-023 ${D_023_PERFORMANCE_SLOS} — ` +
      'no rate, concurrency, or duration is released for this profile',
  };
}
