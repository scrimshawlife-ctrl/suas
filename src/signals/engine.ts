/**
 * Support Signal computation engine interface.
 *
 * Spec citations:
 * - SUAS-specs SUPPORT_SIGNALS.md §1 (a coordination priority label, not a
 *   diagnosis or suicidality determination), §2 (computation contract:
 *   deterministic, inspectable, versioned, unit-tested, reproducible, idempotently
 *   settled; "No generative model may produce the primary signal"), §3
 *   (computation identity), §10 (non-goals)
 * - SUAS-specs SIGNAL_SCORING.md B1–B5 (`qv-001` + `sv-001`; D-011 `DECIDED`)
 * - SUAS-specs CHECKINS.md §4.1 (incomplete input uses the published version's
 *   deterministic missing-input behavior)
 * - SUAS-specs TESTING.md §12 (GV-001–GV-014 are released for `qv-001` + `sv-001`;
 *   other version pairs remain `UNRELEASED_FIXTURE`)
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_SUPPORT_SIGNAL_MODE` = `disabled|fixture`;
 *   "fixture ... is never production authority")
 * - SUAS-specs RELEASE_DECISIONS-0.2.0.md (implementation-authoritative, not
 *   production-operating; APPLY_EFFECTIVE_SIGNAL transcribes SAFETY.md §3.2)
 *
 * The registry ships the released `sv-001` engine. Unreleased fixtures may still
 * register with `released: false` and run only when a caller opts in.
 */

import type { JsonObject } from '../jobs/index.js';
import { SV_001_ENGINE } from './sv-001.js';

/** SUPPORT_SIGNALS.md §1. Exactly these values. */
export const SIGNAL_LEVELS = ['GREEN', 'YELLOW', 'ORANGE', 'RED'] as const;
export type SignalLevel = (typeof SIGNAL_LEVELS)[number];

/** One canonical answer, as the engine sees it. Free text is deliberately absent. */
export interface CanonicalAnswer {
  readonly questionKey: string;
  readonly dimension: string | undefined;
  readonly optionKey: string | undefined;
}

/**
 * The canonical inputs to a computation.
 *
 * SUPPORT_SIGNALS.md §2 requires determinism over *canonical* inputs, and §10
 * forbids generative interpretation of free text as a primary signal — so free
 * text is not part of this structure at all. It cannot be read by an engine
 * because it is never handed to one.
 */
export interface CanonicalSignalInput {
  readonly checkInId: string | undefined;
  readonly sourceReference: string | undefined;
  readonly questionnaireVersion: string | undefined;
  readonly answers: readonly CanonicalAnswer[];
  /** True when required answers are missing. CHECKINS.md §4.1. */
  readonly incomplete: boolean;
}

export interface SignalComputation {
  readonly level: SignalLevel;
  /**
   * Inspectable record of the canonical inputs and rules used.
   * §2: without unnecessary sensitive payload duplication.
   */
  readonly basis: JsonObject;
}

export interface SignalEngine {
  /** Published immutable identifier. SUPPORT_SIGNALS.md §2. */
  readonly signalVersion: string;
  /**
   * Whether this engine implements a released scoring contract.
   *
   * `sv-001` is released by D-011. A fixture engine remains a test instrument
   * and never production authority (ENVIRONMENT.md §3).
   */
  readonly released: boolean;
  /** Whether the engine defines deterministic missing-input behavior (§4.1). */
  readonly handlesIncompleteInput: boolean;
  /** Pure function. Same canonical inputs and version produce the same result. */
  compute(input: CanonicalSignalInput): SignalComputation;
}

export class SignalScoringUnavailableError extends Error {
  readonly code = 'SIGNAL_SCORING_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(detail: string) {
    super(
      `Support Signal scoring is unavailable: ${detail}. D-011 released sv-001 for ` +
        `qv-001; other signal versions have no released engine (SUAS-specs ` +
        `SIGNAL_SCORING.md; SUPPORT_SIGNALS.md §2).`,
    );
    this.name = 'SignalScoringUnavailableError';
  }
}

export class UnreleasedEngineError extends Error {
  readonly code = 'SIGNAL_SCORING_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(signalVersion: string) {
    super(
      `Signal version "${signalVersion}" is an unreleased fixture and is never production ` +
        `authority (SUAS-specs ENVIRONMENT.md §3; TESTING.md §12).`,
    );
    this.name = 'UnreleasedEngineError';
  }
}

export class IncompleteInputError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor() {
    super(
      'This Check-In is incomplete and the signal version defines no deterministic ' +
        'missing-input behavior, so no production Support Signal is computed ' +
        '(SUAS-specs CHECKINS.md §4.1).',
    );
    this.name = 'IncompleteInputError';
  }
}

const ENGINES = new Map<string, SignalEngine>();

function restoreReleasedEngines(): void {
  ENGINES.set(SV_001_ENGINE.signalVersion, SV_001_ENGINE);
}

export function registerSignalEngine(engine: SignalEngine): void {
  ENGINES.set(engine.signalVersion, engine);
}

/**
 * Restore the released registry. Tests use this between cases so a fixture
 * engine cannot leak; `sv-001` remains registered.
 */
export function clearSignalEngines(): void {
  ENGINES.clear();
  restoreReleasedEngines();
}

export function findSignalEngine(signalVersion: string): SignalEngine | undefined {
  return ENGINES.get(signalVersion);
}

export function registeredSignalVersions(): string[] {
  return [...ENGINES.keys()].sort();
}

export interface ComputeOptions {
  /**
   * Allow an unreleased fixture engine to run. Only valid under
   * `SUAS_SUPPORT_SIGNAL_MODE=fixture`, and the result is never production
   * authority.
   */
  readonly allowUnreleasedFixture?: boolean;
}

/**
 * Compute a primary signal, or refuse.
 *
 * `sv-001` is registered as released. Unknown versions still refuse. Unreleased
 * fixtures require an explicit opt-in. Case writes happen at settlement via
 * APPLY_EFFECTIVE_SIGNAL, not here.
 */
export function computeSignal(
  signalVersion: string,
  input: CanonicalSignalInput,
  options: ComputeOptions = {},
): SignalComputation {
  const engine = findSignalEngine(signalVersion);
  if (engine === undefined) {
    throw new SignalScoringUnavailableError(
      `no engine is registered for signal version "${signalVersion}"`,
    );
  }

  if (!engine.released && options.allowUnreleasedFixture !== true) {
    throw new UnreleasedEngineError(signalVersion);
  }

  // CHECKINS.md §4.1: incomplete input needs deterministic missing-input
  // behavior defined by the published signal version.
  if (input.incomplete && !engine.handlesIncompleteInput) {
    throw new IncompleteInputError();
  }

  return engine.compute(input);
}

restoreReleasedEngines();
