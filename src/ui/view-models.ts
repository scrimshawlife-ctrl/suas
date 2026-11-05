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
  /** Present only when this environment offers the synthetic demo sign-in. */
  readonly demoSignIn?: { readonly email: string; readonly code: string };
}

export interface EnrollmentViewModel {
  readonly shell: ShellViewModel;
  /**
   * §7.1: the passwordless contract needs a real channel, so enrollment states
   * the requirement instead of the reference's "No email" promise.
   */
  readonly contactChannelRequirement: string;
  readonly authEnabled?: boolean;
  readonly selectedRole?: 'veteran';
  /** Present only when this environment offers the synthetic demo sign-in. */
  readonly demoSignIn?: { readonly email: string; readonly code: string };
}

export interface EmailOtpViewModel {
  readonly shell: ShellViewModel;
  readonly destination: string;
  readonly selectedRole: 'veteran';
  readonly error?: string;
  /** Shown instead of a "check your email" line for the synthetic demo account. */
  readonly demoCode?: string;
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

export interface AdminProviderCatalogViewModel {
  readonly adapterId: string;
  readonly capability: string;
  readonly integrationMode: string;
  readonly decision: string;
  readonly label: string;
  /** Presence only. Never render credential values. */
  readonly secretPresence: string;
}

export interface AdminProviderConfigurationViewModel {
  readonly adapterConfigurationId: string;
  readonly adapterId: string;
  readonly capability: string;
  readonly integrationMode: string;
  readonly enabled: boolean;
  readonly routingPriority: number;
  readonly health: string;
  readonly coverageCounties: readonly string[];
  readonly secretPresence: string;
  readonly label: string;
}

export interface AdminOverviewViewModel {
  readonly shell: ShellViewModel;
  /** §7.5: explicit `SUAS Admin` terminology, and a visible scope. */
  readonly tenantLabel: string;
  readonly capabilities: readonly AdminCapabilityViewModel[];
  readonly providerCatalog: readonly AdminProviderCatalogViewModel[];
  readonly providerConfigurations: readonly AdminProviderConfigurationViewModel[];
  readonly notice?: string;
  /** Open decisions that currently block operation. */
  readonly blockingDecisions: readonly string[];
  readonly readiness: string;
}

/** A proposed admin module whose canonical API/authorization slice is not released yet. */
export interface AdminPlannedSurfaceViewModel {
  readonly shell: ShellViewModel;
  readonly title: string;
  readonly scope: string;
  readonly reason: string;
  readonly backHref: string;
}
