/**
 * View models: the only inputs a surface may render.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §9 (no fabricated zero/placeholder values as
 *   production facts; summaries only when derived from real data)
 * - SUAS-specs MVP_REFERENCE.md §8 (resource data is not timeless hard-coded truth)
 * - SUAS-specs MVP_REFERENCE.md §11 (deterministic fixture data)
 * - SUAS-specs PRIVACY.md (minimum necessary; no veteran address in a surface
 *   that does not need it)
 *
 * Rendering is a pure function of these types. That is what makes §11's
 * fixtures deterministic without a browser or a database, and it keeps the
 * question "may this surface see this field?" answerable by reading one file.
 *
 * A value that is genuinely unknown is modelled as `undefined` or as an
 * explicit `NOT_COMPUTABLE` variant, never as `0` or `'—'`. §9 forbids
 * displaying fabricated placeholder values as production facts, and a metric
 * that defaults to zero is exactly that.
 */

import type { ContactMethodKind, FreshnessBand } from '../fulfillment/index.js';
import type { SafetyCopyMode, SupportSignalMode } from '../config/index.js';
import type { CategoryCard } from './categories.js';
import type { QrfFacts } from './qrf.js';

/** MVP_REFERENCE.md §11 records a viewport/device class per fixture. */
export const VIEWPORT_CLASSES = ['MOBILE', 'DESKTOP'] as const;
export type ViewportClass = (typeof VIEWPORT_CLASSES)[number];

/** Shared chrome. Every authenticated surface renders the same simple nav. */
export interface ShellViewModel {
  readonly title: string;
  readonly viewport: ViewportClass;
  /** Which persistent nav entry is current, if the surface is in the nav. */
  readonly currentNav?: 'HOME' | 'CHAT';
  /** Rendered only on operational surfaces. §5 persistent mobile nav. */
  readonly showMobileNav: boolean;
}

export interface LandingViewModel {
  readonly shell: ShellViewModel;
  /**
   * Mission line. §7.4: brand may preserve urgency and service framing, but
   * unsupported statistics and clinical efficacy claims are not production
   * copy. No statistic field exists here on purpose.
   */
  readonly missionLine: string;
}

export interface EnrollmentViewModel {
  readonly shell: ShellViewModel;
  /**
   * §7.1: the passwordless contract needs a real channel, so enrollment states
   * the requirement instead of the reference's "No email" promise.
   */
  readonly contactChannelRequirement: string;
}

export interface QrfCardViewModel {
  readonly facts: QrfFacts;
  readonly authorizedVoicePath: boolean;
  readonly authorizedMessagePath: boolean;
}

/**
 * One inbox row. Matches the public JSON notification shape (no destination,
 * no body — NOTIFICATIONS.md §10 / PRIVACY.md).
 */
export interface NotificationRowViewModel {
  readonly reason: string;
  readonly channel: string;
  readonly deliveryStatus: string;
  readonly attemptCount: number;
  /** ISO timestamp when known; absent when not yet sent. */
  readonly sentAtLabel?: string;
  readonly subjectType?: string;
}

export interface NotificationsInboxViewModel {
  readonly shell: ShellViewModel;
  readonly notifications: readonly NotificationRowViewModel[];
  /** Echo of the applied limit (API default 50, max 100). */
  readonly limit: number;
  /** Optional link to channel preference controls. */
  readonly preferencesHref?: string;
}

/**
 * Channel preference row. Preferences select a channel and never grant consent
 * (NOTIFICATIONS.md §4.4). Absent rows are treated as enabled.
 */
export interface NotificationPreferenceRowViewModel {
  readonly channel: string;
  readonly enabled: boolean;
}

export interface NotificationPreferencesViewModel {
  readonly shell: ShellViewModel;
  readonly preferences: readonly NotificationPreferenceRowViewModel[];
}

export interface VeteranHomeViewModel {
  readonly shell: ShellViewModel;
  readonly categories: readonly CategoryCard[];
  /** Present when the veteran has a QRF request in flight. */
  readonly activeQrf?: QrfCardViewModel;
  /**
   * Safety-copy mode for the immediate-resources slot (D-012). Absent ⇒
   * fail-closed placeholder; `approved` renders the released 911/988 copy.
   */
  readonly safetyCopyMode?: SafetyCopyMode;
  /**
   * Optional Check-In entry. Absent on the §11 home fixture so the required
   * inventory stays Check-In-free. The live `/app/home` always supplies it.
   */
  readonly checkInLink?: CheckInHomeLinkViewModel;
  /**
   * Optional notifications inbox entry. Not in MVP_REFERENCE.md §5 inventory;
   * live `/app/home` supplies it. Mobile nav stays Home+Chat only (§5).
   */
  readonly notificationsHref?: string;
  /**
   * Optional privacy links. Not in MVP_REFERENCE.md §5 inventory; live home
   * supplies them. Invite channels never appear on these pages.
   */
  readonly consentsHref?: string;
  readonly trustedContactsHref?: string;
}

/** One consent grant row (public JSON shape — PRIVACY.md self grants only). */
export interface ConsentGrantRowViewModel {
  readonly permission: string;
  readonly scope: string;
  readonly purpose: string;
  readonly granteeType: string;
  readonly status: string;
  readonly grantedAtLabel: string;
  readonly expiresAtLabel?: string;
}

export interface ConsentsListViewModel {
  readonly shell: ShellViewModel;
  readonly grants: readonly ConsentGrantRowViewModel[];
}

/**
 * One trusted-circle row. Matches public JSON (relationship + status only —
 * no invite email/phone — TRUSTED_CIRCLE.md / PRIVACY.md).
 */
export interface TrustedContactRowViewModel {
  readonly relationshipLabel: string;
  readonly status: string;
}

export interface TrustedContactsListViewModel {
  readonly shell: ShellViewModel;
  readonly contacts: readonly TrustedContactRowViewModel[];
}

/** Truthful home entry to the Check-In HTML loop. Not a scoring dashboard. */
export interface CheckInHomeLinkViewModel {
  readonly href: string;
  readonly label: string;
}

export interface CheckInStartViewModel {
  readonly shell: ShellViewModel;
  readonly supportSignalMode: SupportSignalMode;
  /** Present when the veteran already has a STARTED or IN_PROGRESS Check-In. */
  readonly inProgressHref?: string;
}

export interface CheckInOptionViewModel {
  readonly answerOptionId: string;
  readonly label: string;
}

export interface CheckInQuestionViewModel {
  readonly questionId: string;
  readonly prompt: string;
  readonly required: boolean;
  readonly options: readonly CheckInOptionViewModel[];
}

export interface CheckInResultViewModel {
  readonly statusLabel: string;
  readonly headline: string;
  readonly detail: string;
}

export interface CheckInSessionViewModel {
  readonly shell: ShellViewModel;
  readonly checkInId: string;
  readonly status: string;
  readonly questionnaireVersion: string;
  readonly questionIndex?: number;
  readonly questionCount?: number;
  readonly currentQuestion?: CheckInQuestionViewModel;
  readonly result?: CheckInResultViewModel;
  readonly canComplete: boolean;
}

export interface QrfRequestViewModel {
  readonly shell: ShellViewModel;
  readonly qrf: QrfCardViewModel;
}

export interface ResourceCategoriesViewModel {
  readonly shell: ShellViewModel;
  readonly categories: readonly CategoryCard[];
}

/**
 * A resource row.
 *
 * §8 asks for "direct phone/email/web actions where allowed". P-13 gives the
 * catalog's `contact_method` a scheme discriminator (`contactMethodKind`), so
 * the surface can offer a direct `tel:`/`mailto:`/web action when the value is a
 * recorded PHONE/EMAIL/URL. Without a kind (or with `FREEFORM`) the value is
 * still shown as text and no action is guessed — the release never parses a
 * scheme out of free text.
 */
export interface ResourceRowViewModel {
  readonly id: string;
  readonly name: string;
  /** Coverage context, shown only where verified. §8. */
  readonly coverage?: string;
  /** RESOURCES.md §6 `contact_method`, verbatim. */
  readonly contactMethod?: string;
  /**
   * Scheme of `contactMethod` (P-13). Present only when the catalog recorded a
   * structured, actionable scheme; absent means render the value as text.
   */
  readonly contactMethodKind?: ContactMethodKind;
  readonly hours?: string;
  readonly cost?: string;
  /** Verification freshness. §8 "visible freshness/availability truth when known". */
  readonly freshness: FreshnessBand;
  /** True when freshness requires an explicit staleness warning. */
  readonly staleWarning: boolean;
}

export interface ResourceListViewModel {
  readonly shell: ShellViewModel;
  readonly categoryLabel: string;
  readonly rows: readonly ResourceRowViewModel[];
  /** Keyset cursor for §8 progressive loading. Absent when the list is complete. */
  readonly nextCursor?: string;
  readonly backHref: string;
}

/**
 * A responder metric. §9 permits `Responses`, `Rating`, `This Month`, and
 * `Avg Response` "only if exact definitions/data are specified". No released
 * spec defines them, so the value variant carries that fact instead of a zero.
 */
export interface ResponderMetricViewModel {
  readonly label: string;
  readonly state: 'AVAILABLE' | 'NOT_COMPUTABLE';
  /** Present only when `state` is `AVAILABLE`. */
  readonly value?: string;
  /** Why it is not computable, when it is not. */
  readonly reason?: string;
}

export interface ActiveNeedViewModel {
  readonly caseId: string;
  /** Canonical Case status. §5 "canonical Case/Request state applies". */
  readonly caseStatus: string;
  readonly category: string;
  /** Human-readable age, derived from a real timestamp. */
  readonly openedLabel: string;
  /** Queue-filter fact only (CASES.md §3). Absent when unset. */
  readonly prioritySignalLevel?: string;
  /** Unassigned OPEN/TRIAGED cases may be claimed (RESPONDER_WORKFLOWS.md §2). */
  readonly claimable?: boolean;
}

/**
 * Contact attempt row for the HTML case page. Matches the public JSON shape
 * (no note / destination — PRIVACY.md / contact-log route).
 */
export interface ContactAttemptRowViewModel {
  readonly channel: string;
  readonly outcome: string;
  /** ISO timestamp or short label already formatted for display. */
  readonly attemptedAtLabel: string;
}

/**
 * Service request row for the HTML case page. Matches the public JSON shape
 * (category + status only; details stay off the HTML surface).
 */
export interface ServiceRequestRowViewModel {
  readonly category: string;
  readonly status: string;
}

/**
 * Released contact channels for the HTML log form (EVENT_MODEL.md §3.3).
 * Keep in sync with `CONTACT_CHANNELS` in coordination/contact.ts.
 */
export const CONTACT_CHANNEL_OPTIONS = ['EMAIL', 'SMS', 'IN_APP', 'PHONE'] as const;

/**
 * Released contact outcomes for the HTML log form (EVENT_MODEL.md §3.3).
 * Keep in sync with `CONTACT_OUTCOMES` in coordination/contact.ts.
 */
export const CONTACT_OUTCOME_OPTIONS = [
  'PENDING',
  'REACHED',
  'NO_ANSWER',
  'LEFT_MESSAGE',
  'DECLINED',
  'UNABLE',
] as const;

/**
 * MVP service categories for the HTML create form (DISPATCH.md §7).
 * Keep in sync with `SERVICE_CATEGORIES` in coordination/request-transitions.ts.
 */
export const SERVICE_CATEGORY_OPTIONS = [
  'FOOD',
  'TRANSPORTATION',
  'SHELTER',
  'PEER_SUPPORT',
] as const;

export interface ResponderCaseViewModel {
  readonly shell: ShellViewModel;
  readonly need: ActiveNeedViewModel;
  /** Bounded contact-attempt page (newest first). Empty when none recorded. */
  readonly contactAttempts: readonly ContactAttemptRowViewModel[];
  /** Bounded service-request page (newest first). Empty when none recorded. */
  readonly serviceRequests: readonly ServiceRequestRowViewModel[];
  /**
   * When true, render the log-contact form. Requires an active assignment for
   * this responder (RESPONDER_WORKFLOWS.md §2). Absent/false for unclaimed cases.
   */
  readonly canLogContact?: boolean;
  /**
   * When true, render the create-service-request form. Parent case must not be
   * CLOSED (DISPATCH.md §4). Absent/false when the case cannot accept creates.
   */
  readonly canCreateServiceRequest?: boolean;
}

/**
 * On-duty availability. G-I-30 / MVP_REFERENCE.md §9: on-duty is not a
 * recorded domain fact. A boolean on/off would claim a stored roster that
 * no released table has. The only honest state is UNAVAILABLE.
 */
export type DutyAvailability = {
  readonly status: 'UNAVAILABLE';
  readonly reason: string;
};

/** Live and fixture copy. Does not claim that requests are or are not received. */
export const DUTY_UNAVAILABLE_REASON =
  'On-duty is not a recorded fact. This build does not store responder availability.';

export interface ResponderDashboardViewModel {
  readonly shell: ShellViewModel;
  readonly duty: DutyAvailability;
  /** Same-tenant unassigned Cases. RESPONDER_WORKFLOWS.md §4. */
  readonly unassignedNeeds?: readonly ActiveNeedViewModel[];
  /**
   * Keyset cursor for the unassigned list (API.md §5). Absent when the page is
   * complete. Surfaces link it as `unassigned_cursor`.
   */
  readonly unassignedNextCursor?: string;
  readonly activeNeeds: readonly ActiveNeedViewModel[];
  /**
   * Keyset cursor for the active-needs list (API.md §5). Absent when the page
   * is complete. Surfaces link it as `active_cursor`.
   */
  readonly activeNextCursor?: string;
  readonly alerts: readonly string[];
  /** §9.3 Quick Resource Share covers the released MVP capabilities only. */
  readonly quickShareCategories: readonly CategoryCard[];
  readonly metrics: readonly ResponderMetricViewModel[];
}

export interface ResponderAvailabilityViewModel {
  readonly shell: ShellViewModel;
  readonly duty: DutyAvailability;
  /** Coverage hours are D-009 `DECISION_PENDING`; absent rather than invented. */
  readonly coverageWindow?: string;
}

export interface ActiveNeedsViewModel {
  readonly shell: ShellViewModel;
  readonly needs: readonly ActiveNeedViewModel[];
  /** Keyset cursor for §5 progressive loading. Absent when the list is complete. */
  readonly nextCursor?: string;
}

export interface ChatThreadViewModel {
  readonly threadId: string;
  readonly counterpartLabel: string;
  readonly lastMessagePreview?: string;
}

/**
 * Chat is either unavailable with a stated reason, or available with a thread
 * list that may be empty.
 *
 * A union rather than an optional reason, because "no threads and no reason"
 * renders as an empty inbox — which implies working messaging. No released
 * slice stores a thread, so that state would always be a lie today, and the
 * type makes it unrepresentable rather than relying on every caller to
 * remember. The slice that implements messaging supplies `AVAILABLE`.
 */
export type ChatAvailability =
  | { readonly status: 'UNAVAILABLE'; readonly reason: string }
  | { readonly status: 'AVAILABLE'; readonly threads: readonly ChatThreadViewModel[] };

export interface ChatViewModel {
  readonly shell: ShellViewModel;
  readonly availability: ChatAvailability;
}

/** A capability's readiness, as the admin overview may state it. */
export interface AdminCapabilityViewModel {
  readonly name: string;
  /** ARCHITECTURE.md: presence only, never credential values. */
  readonly presence: 'CONFIGURED' | 'MISSING';
  readonly note?: string;
}

export interface AdminOverviewViewModel {
  readonly shell: ShellViewModel;
  /** §7.5: explicit `SUAS Admin` terminology, and a visible scope. */
  readonly tenantLabel: string;
  readonly capabilities: readonly AdminCapabilityViewModel[];
  /** Open decisions that currently block operation. */
  readonly blockingDecisions: readonly string[];
  readonly readiness: string;
}
