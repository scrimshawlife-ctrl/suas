/**
 * The immediate-resource slot, rendering the D-012 approved crisis copy.
 *
 * Spec citations:
 * - SUAS-specs SAFETY.md §2 (approved on-screen safety copy is released by D-012
 *   in SAFETY_COPY.md; implementations render it and must not invent alternative
 *   crisis wording presented as official; authorized destinations are 911 / 988)
 * - SUAS-specs SAFETY.md §3.1 (show the veteran the *approved* crisis-resource list)
 * - SUAS-specs SAFETY.md §5.1 / SAFETY_COPY.md §5 (state truthfulness)
 * - SUAS-specs SAFETY.md §9 (`RED` surfaces the approved-resource slot and does
 *   not call an emergency API)
 * - SUAS-specs SAFETY_COPY.md §1, §2 (approved copy + destinations, v0.1.5)
 * - SUAS-specs MVP_REFERENCE.md §7.3 (placement `MUST_MATCH`; exact copy
 *   `MUST_MATCH` the D-012 approved wording)
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_SAFETY_COPY_MODE=approved` renders the
 *   released copy; `placeholder_test_only` renders the reserved placeholder)
 * - SUAS-specs DECISIONS.md D-012 (`DECIDED`, v0.1.5)
 *
 * The reference gives crisis resources a prominent, dominant placement, and §7.3
 * requires production to *preserve that placement*. D-012 released the approved
 * wording and destinations, so the slot renders them in `approved` mode. It stays
 * fail-closed: any non-`approved` mode renders a labelled placeholder rather than
 * crisis wording, so an environment that has not opted into the approved copy
 * never shows a crisis destination. This is a display of resources, not a
 * dispatch — SUAS performs no automated 911/PSAP call (SAFETY.md §2).
 */

import type { SafetyCopyMode } from '../config/index.js';

/** DECISIONS.md D-012 — closed by v0.1.5 (approved copy in SAFETY_COPY.md). */
export const D_012_APPROVED_SAFETY_COPY = 'DECIDED' as const;

export interface ApprovedCrisisResource {
  readonly label: string;
  /** Destination approved by D-012. Not a link this implementation chose. */
  readonly destination: string;
  /** The released decision text this entry transcribes. */
  readonly approvedUnder: string;
}

/**
 * Pinned spec 0.7.0 SAFETY_COPY released destinations: 911 and 988 (call or text)
 * only. No tracking parameters and no other released number.
 */
export const APPROVED_CRISIS_DESTINATIONS = ['tel:911', 'tel:988', 'sms:988'] as const;

/**
 * 838255 (sms:838255, Text 838255): owner-decided as D-050 on 2026-11-05,
 * pending a spec release; the pinned spec 0.7.0 SAFETY_COPY authorizes only
 * 911 and 988.
 * Owner decision (owner (scrimshawlife-ctrl), 2026-11-05 1:20 PM PT): "You can keep those numbers" /
 * "Just label them appropriately". That does not settle a spec release.
 * The footer must label 838255 as the Veterans Crisis Line text number.
 * Do not describe this destination as released in the pinned spec.
 */
export const PENDING_RELEASE_CRISIS_DESTINATIONS = ['sms:838255'] as const;

/**
 * SAFETY_COPY.md §1.1 primary actions (D-012).
 *
 * Labels are the released primary-action wording, verbatim. Those slot
 * destinations are `tel:911` and `tel:988` — no tracking parameters.
 */
export const APPROVED_CRISIS_RESOURCES: readonly ApprovedCrisisResource[] = [
  {
    label: 'Call 911',
    destination: 'tel:911',
    approvedUnder: 'SAFETY_COPY.md §1.1 (D-012, v0.1.5)',
  },
  {
    label: 'Call or text 988',
    destination: 'tel:988',
    approvedUnder: 'SAFETY_COPY.md §1.1 (D-012, v0.1.5)',
  },
];

/** SAFETY_COPY.md §1.1 heading. */
export const CRISIS_ENTRY_HEADING = 'Need help right now?';

/** SAFETY_COPY.md §1.1 paragraph 1, without markdown emphasis. */
export const CRISIS_ENTRY_DANGER =
  'If you are in immediate danger, have a medical emergency, or believe someone may be seriously harmed, call 911 or go to the nearest emergency department.';

/** SAFETY_COPY.md §1.1 paragraph 2. */
export const CRISIS_ENTRY_NOT_EMERGENCY =
  'SUAS coordinates practical support. It is not an emergency service and cannot replace police, fire, EMS, or emergency medical care.';

/** SAFETY_COPY.md §1.1 paragraph 3. */
export const CRISIS_ENTRY_LIFELINE =
  'If you are experiencing suicidal thoughts, severe emotional distress, or a mental health crisis, call or text the 988 Suicide & Crisis Lifeline at 988.';

/** SAFETY_COPY.md §2.1 compact banner, joined as one paragraph. */
export const CRISIS_BANNER_COMPACT =
  'Immediate danger? Call 911. For suicide or emotional crisis support, call or text 988. SUAS provides practical support coordination and is not an emergency-response service.';

/** SAFETY_COPY.md §2.3 persistent footer, joined as one paragraph. */
export const CRISIS_FOOTER =
  'SUAS coordinates community support. It does not provide emergency medical care or emergency dispatch. For immediate danger, call 911. For suicide or emotional crisis support, call or text 988.';

export const IMMEDIATE_RESOURCE_SLOT_STATES = ['APPROVED', 'PLACEHOLDER'] as const;
export type ImmediateResourceSlotState = (typeof IMMEDIATE_RESOURCE_SLOT_STATES)[number];

export interface ImmediateResourceSlot {
  readonly state: ImmediateResourceSlotState;
  readonly resources: readonly ApprovedCrisisResource[];
  /**
   * Shown in the reserved slot when the approved copy is not selected. States the
   * unavailability as a fact about this build; it gives no crisis guidance,
   * no destination, and no clinical framing.
   */
  readonly placeholder?: string;
  readonly basis: string;
}

/**
 * Resolve what the reserved immediate-resource slot renders for a safety-copy mode.
 *
 * Fail-closed: only `approved` (D-012) renders the released 911/988 copy; every
 * other mode renders a visible, labelled placeholder. Never throws — §7.3
 * requires the placement to survive regardless of mode.
 */
export function resolveImmediateResourceSlot(
  mode: SafetyCopyMode = 'placeholder_test_only',
): ImmediateResourceSlot {
  if (mode === 'approved' && APPROVED_CRISIS_RESOURCES.length > 0) {
    return {
      state: 'APPROVED',
      resources: APPROVED_CRISIS_RESOURCES,
      basis: 'SAFETY.md §3.1; SAFETY_COPY.md §1 (D-012, v0.1.5)',
    };
  }
  return {
    state: 'PLACEHOLDER',
    resources: [],
    placeholder:
      'Approved immediate-resource information is not available in this build. ' +
      'This section is reserved and will show the approved resources once they are released.',
    basis: `SAFETY.md §2 and §9; SUAS_SAFETY_COPY_MODE=${mode}`,
  };
}

export class UnapprovedSafetyCopyError extends Error {
  readonly code = 'UNAPPROVED_SAFETY_COPY';
  readonly httpStatus = 409;
  constructor(context: string) {
    super(
      `${context} requires the approved production safety copy, which renders only when ` +
        'SUAS_SAFETY_COPY_MODE=approved (SUAS-specs SAFETY_COPY.md, D-012). The current mode ' +
        'does not render the approved crisis copy; SAFETY.md §2 forbids inventing crisis-resource ' +
        'wording presented as official.',
    );
    this.name = 'UnapprovedSafetyCopyError';
  }
}

/**
 * Refuse to present crisis copy as official unless the approved copy is selected.
 *
 * Any caller that renders authoritative safety wording — a red check-in outcome,
 * a veteran-initiated emergency screen (SAFETY.md §5) — goes through here and is
 * refused unless `SUAS_SAFETY_COPY_MODE=approved`, rather than reaching for a
 * string constant.
 */
export function assertApprovedSafetyCopyAvailable(
  context: string,
  mode: SafetyCopyMode = 'placeholder_test_only',
): void {
  if (mode !== 'approved' || APPROVED_CRISIS_RESOURCES.length === 0) {
    throw new UnapprovedSafetyCopyError(context);
  }
}
