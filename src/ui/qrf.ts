/**
 * QRF deploy states, as labels over canonical facts.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §7.2 (QRF deployment truthfulness)
 * - SUAS-specs MVP_REFERENCE.md §4.8 (operational states visible and truthful)
 * - SUAS-specs DISPATCH.md §7 / coordination (canonical Service Request states)
 * - SUAS-specs SAFETY.md §2 (no emergency dispatch)
 *
 * §7.2 permits these UI labels only as "labels mapped to canonical
 * Case/Request/notification facts, not new hidden domain states". So this
 * module owns no state of its own: it is a total function from facts the
 * domain already recorded to the label the veteran sees.
 *
 * The load-bearing rule is negative. Production must not "guarantee immediate
 * notification/contact unless the system actually knows it occurred", so
 * `RESPONDER_NOTIFIED` requires a recorded delivery fact — an acceptance alone
 * reads as still searching.
 */

import { findRequestTransition, type ServiceRequestStatus } from '../coordination/index.js';

/** MVP_REFERENCE.md §7.2, verbatim. */
export const QRF_UI_STATES = [
  'REQUESTED',
  'SEARCHING',
  'RESPONDER_NOTIFIED',
  'RESPONDER_ACCEPTED',
  'NO_RESPONDER_CURRENTLY_AVAILABLE',
  'DEGRADED',
  'CANCELLED',
] as const;
export type QrfUiState = (typeof QRF_UI_STATES)[number];

/**
 * The canonical facts a QRF label is allowed to depend on. Each field is
 * something the system actually recorded, never an inference about the world.
 */
export interface QrfFacts {
  readonly requestStatus: ServiceRequestStatus;
  /** Someone accepted the case: an active assignment exists. */
  readonly assigned: boolean;
  /**
   * A notification to the person who accepted reached a delivered state. Not
   * "we enqueued one" — §7.2 forbids claiming contact the system cannot see.
   */
  readonly assignedNotificationDelivered: boolean;
  /**
   * Coordination could not run normally: the notification channel, job queue,
   * or fulfillment adapter failed closed. Surfaces as `DEGRADED` so a stalled
   * request never reads as a calm ongoing search.
   */
  readonly coordinationDegraded: boolean;
  /** Matching completed and produced no one available. */
  readonly matchingExhausted: boolean;
}

/**
 * Statuses that are only reachable through `ACCEPTED`. DISPATCH.md §2 orders
 * the spine `ACCEPTED → IN_PROGRESS → FULFILLED → CONFIRMED → CLOSED`, so each
 * of these carries the acceptance evidence the §7.2 `RESPONDER_ACCEPTED` row
 * rests on. Falling through to `SEARCHING` would tell a veteran whose request
 * was fulfilled that SUAS is still looking for someone.
 */
const ACCEPTANCE_RECORDED: readonly ServiceRequestStatus[] = [
  'ACCEPTED',
  'IN_PROGRESS',
  'FULFILLED',
  'CONFIRMED',
  'CLOSED',
];

/**
 * Whether the veteran may still cancel: true exactly when DISPATCH.md §4
 * documents a `CANCEL` edge from this status. Offering cancel anywhere else
 * shows an action the domain would refuse with `ILLEGAL_TRANSITION`.
 */
function isCancellable(status: ServiceRequestStatus): boolean {
  return findRequestTransition('CANCEL', status) !== undefined;
}

export interface QrfPresentation {
  readonly state: QrfUiState;
  /** Short, direct veteran-facing line. §4.2 low cognitive load. */
  readonly headline: string;
  /** The canonical fact this label rests on, for audit and review. */
  readonly basis: string;
  /**
   * Whether the veteran may still cancel. §7.2 preserves cancel; DISPATCH.md §4
   * decides from which statuses it exists.
   */
  readonly cancellable: boolean;
}

/**
 * Map canonical facts to the veteran-facing label.
 *
 * Order matters: a degraded coordination path outranks an optimistic search
 * label, and an exhausted match outranks a generic "searching", because §4.8
 * requires the *truthful* state to be the visible one.
 */
export function presentQrfState(facts: QrfFacts): QrfPresentation {
  const cancellable = isCancellable(facts.requestStatus);

  if (facts.requestStatus === 'CANCELLED') {
    return {
      state: 'CANCELLED',
      headline: 'Request cancelled.',
      basis: 'Service Request status CANCELLED',
      cancellable,
    };
  }

  if (ACCEPTANCE_RECORDED.includes(facts.requestStatus)) {
    return {
      state: 'RESPONDER_ACCEPTED',
      headline: 'Someone accepted your request.',
      basis: `Service Request status ${facts.requestStatus}`,
      cancellable,
    };
  }

  if (facts.coordinationDegraded) {
    return {
      state: 'DEGRADED',
      headline: 'We are having trouble coordinating right now. Your request is still recorded.',
      basis: 'A coordination dependency failed closed',
      cancellable,
    };
  }

  if (
    facts.requestStatus === 'UNFULFILLABLE' ||
    facts.requestStatus === 'EXPIRED' ||
    facts.requestStatus === 'DECLINED' ||
    facts.matchingExhausted
  ) {
    return {
      state: 'NO_RESPONDER_CURRENTLY_AVAILABLE',
      headline: 'No one is available right now. Your request is still recorded.',
      basis:
        facts.requestStatus === 'MATCHING'
          ? 'Matching completed with no one available'
          : `Service Request status ${facts.requestStatus}`,
      cancellable,
    };
  }

  if (facts.assigned && facts.assignedNotificationDelivered) {
    return {
      state: 'RESPONDER_NOTIFIED',
      headline: 'Someone has been notified.',
      basis: 'Active assignment plus a recorded notification delivery',
      cancellable,
    };
  }

  if (facts.requestStatus === 'CREATED' || facts.requestStatus === 'SUBMITTED') {
    return {
      state: 'REQUESTED',
      headline: 'Your request is recorded.',
      basis: `Service Request status ${facts.requestStatus}`,
      cancellable,
    };
  }

  // Assigned-but-unconfirmed lands here deliberately: an assignment is not
  // evidence that anyone was reached (§7.2).
  return {
    state: 'SEARCHING',
    headline: 'Looking for someone to help.',
    basis: facts.assigned
      ? 'Active assignment with no recorded notification delivery'
      : `Service Request status ${facts.requestStatus}`,
    cancellable,
  };
}

/**
 * Whether `Call` and `Message` may be shown.
 *
 * §7.2: "`Call` and `Message` appear only when an authorized contact path
 * actually exists." Existence is not enough — the path must be consented and
 * currently usable, which the caller resolves from the consent kernel.
 */
export interface ContactAffordances {
  readonly call: boolean;
  readonly message: boolean;
}

export function contactAffordances(input: {
  readonly state: QrfUiState;
  /** A consented, currently usable voice path to the person who accepted. */
  readonly authorizedVoicePath: boolean;
  /** A consented, currently usable message path to the person who accepted. */
  readonly authorizedMessagePath: boolean;
}): ContactAffordances {
  // Before acceptance there is no counterpart to contact, whatever consent says.
  const counterpartExists =
    input.state === 'RESPONDER_ACCEPTED' || input.state === 'RESPONDER_NOTIFIED';
  return {
    call: counterpartExists && input.authorizedVoicePath,
    message: counterpartExists && input.authorizedMessagePath,
  };
}
