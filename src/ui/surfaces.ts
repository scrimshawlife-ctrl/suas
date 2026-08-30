/**
 * The required surfaces, rendered.
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §3 (observed MVP interaction spine)
 * - SUAS-specs MVP_REFERENCE.md §4 (visual/product principles)
 * - SUAS-specs MVP_REFERENCE.md §5 (required surface inventory)
 * - SUAS-specs MVP_REFERENCE.md §7 (mandatory production divergences)
 * - SUAS-specs MVP_REFERENCE.md §8 (resource-screen fidelity)
 * - SUAS-specs MVP_REFERENCE.md §9 (responder dashboard fidelity)
 * - SUAS-specs MVP_REFERENCE.md §10 (WCAG 2.2 AA)
 *
 * Every function is pure: view model in, markup out. Each ends by asserting its
 * §5 required elements, so a surface cannot lose a reference-critical action
 * silently even if a future edit rearranges it.
 */

import {
  a,
  button,
  dd,
  details,
  div,
  dl,
  dt,
  fieldset,
  form,
  h1,
  h2,
  h3,
  header,
  input,
  label,
  legend,
  li,
  main,
  nav,
  ol,
  option,
  p,
  raw,
  render,
  section,
  select,
  span,
  summary,
  ul,
  type Renderable,
} from './html.js';
import { assertRequiredElementsPresent, type SurfaceId } from './contract.js';
import { contactAffordances, presentQrfState } from './qrf.js';
import {
  CRISIS_BANNER_COMPACT,
  CRISIS_ENTRY_DANGER,
  CRISIS_ENTRY_HEADING,
  CRISIS_ENTRY_LIFELINE,
  CRISIS_ENTRY_NOT_EMERGENCY,
  CRISIS_FOOTER,
  resolveImmediateResourceSlot,
  type ImmediateResourceSlot,
} from './safety.js';
import type { SafetyCopyMode } from '../config/index.js';
import { STYLESHEET } from './theme.js';
import {
  CONTACT_CHANNEL_OPTIONS,
  CONTACT_OUTCOME_OPTIONS,
  SERVICE_CATEGORY_OPTIONS,
} from './view-models.js';
import type {
  ActiveNeedsViewModel,
  ActiveNeedViewModel,
  AdminOverviewViewModel,
  ChatViewModel,
  CheckInSessionViewModel,
  CheckInStartViewModel,
  EnrollmentViewModel,
  EmailOtpViewModel,
  LandingViewModel,
  QrfCardViewModel,
  QrfRequestViewModel,
  ResourceCategoriesViewModel,
  ResourceListViewModel,
  ResourceRowViewModel,
  DutyAvailability,
  ConsentsListViewModel,
  NotificationPreferencesViewModel,
  NotificationsInboxViewModel,
  TrustedContactsListViewModel,
  ResponderAvailabilityViewModel,
  ResponderCaseViewModel,
  ResponderDashboardViewModel,
  ShellViewModel,
  VeteranHomeViewModel,
} from './view-models.js';
import type { CategoryCard } from './categories.js';

/** Circle plus horizontal axis. Not a vertical strike. */
const ZERO_MARK = raw(
  '<svg class="zero-mark" width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">' +
    '<circle cx="16" cy="16" r="8.25" fill="none" stroke="currentColor" stroke-width="1.35"></circle>' +
    '<line x1="3.5" y1="16" x2="28.5" y2="16" stroke="currentColor" stroke-width="1.35"></line>' +
    '</svg>',
);

/** Canonical loop. CONTEXT.md; do not invent steps. */
const CANONICAL_LOOP = [
  'SIGNAL',
  'NEED',
  'CONSENT',
  'COORDINATION',
  'FULFILLMENT',
  'FOLLOW-UP',
  'SETTLEMENT',
] as const;

/**
 * Shared chrome: zero-mark, wordmark, and the SPEC-017 not-ready pill.
 *
 * Not a surface. Sits outside `main` so the skip link still jumps to content.
 */
function siteChrome(shell: ShellViewModel): Renderable {
  return header(
    { class: 'site-chrome' },
    span({ class: 'brand' }, ZERO_MARK, span({ class: 'brand-name' }, 'zer0state')),
    p({ class: 'status-pill' }, 'SPEC-017 · NOT READY'),
    shell.showMobileNav
      ? form(
          { method: 'post', action: '/app/auth/logout', class: 'logout-form' },
          button({ class: 'logout-action', type: 'submit' }, 'Sign out'),
        )
      : undefined,
  );
}

/**
 * Wrap a surface in the document shell.
 *
 * `lang` (WCAG 3.1.1), a skip link (2.4.1), one `main` landmark, and a viewport
 * meta that permits zoom (1.4.4 — `user-scalable=no` would fail it).
 */
function document(shell: ShellViewModel, body: Renderable): string {
  return [
    '<!doctype html>',
    render(
      raw(`<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B0D0C">
<title>${render(shell.title)} — SUAS</title>
<style>${STYLESHEET}</style>
</head>
<body>${render([
        a({ href: '#main', class: 'skip-link' }, 'Skip to main content'),
        div({ class: 'shell' }, [siteChrome(shell), main({ id: 'main' }, body)]),
        shell.showMobileNav ? mobileNav(shell) : undefined,
      ])}</body>
</html>`),
    ),
  ].join('\n');
}

/** §5 persistent mobile nav: Home + Chat, nothing else. §4.9 forbids density drift. */
export function mobileNav(shell: ShellViewModel): Renderable {
  const entry = (href: string, text: string, key: 'HOME' | 'CHAT'): Renderable =>
    a(
      {
        href,
        // 4.1.2 / 2.4.8: current location is programmatic, not colour-only.
        'aria-current': shell.currentNav === key ? 'page' : undefined,
      },
      text,
    );

  return nav(
    { class: 'mobile-nav', 'aria-label': 'Primary' },
    entry('/app/home', 'Home', 'HOME'),
    entry('/app/chat', 'Chat', 'CHAT'),
  );
}

/** A state block. §4.8 requires the state to be visible, named, and truthful. */
function stateBlock(label_: string, headline: string, detail?: string): Renderable {
  return div(
    { class: 'state', role: 'status' },
    // 1.4.1: the state name is text; styling only adds emphasis.
    p({}, span({ class: 'badge' }, label_)),
    p({}, headline),
    detail === undefined ? undefined : p({ class: 'muted' }, detail),
  );
}

/**
 * §9.1 keeps the On Duty landmark. G-I-30: the landmark is not a stored
 * on/off fact, so the block states unavailability the way chat does.
 */
function dutyUnavailability(duty: DutyAvailability): Renderable {
  return stateBlock('Unavailable', duty.reason);
}

/**
 * The reserved immediate-resource slot.
 *
 * §7.3 keeps the placement. In `approved` mode the slot renders the D-012
 * wording from SAFETY_COPY.md §1.1 / §2; any other mode stays a labelled
 * placeholder so an un-opted-in environment never shows a crisis destination.
 */
export function immediateResources(mode: SafetyCopyMode = 'placeholder_test_only'): Renderable {
  const slot = resolveImmediateResourceSlot(mode);
  return section(
    { 'aria-labelledby': 'immediate-resources' },
    h2({ id: 'immediate-resources' }, 'Immediate Resources'),
    slot.state === 'PLACEHOLDER'
      ? div({ class: 'reserved-slot' }, p({}, slot.placeholder ?? ''))
      : approvedCrisisCopy(slot),
  );
}

/** SAFETY_COPY.md §1.1 + §2.1 + §2.3 — approved crisis copy, verbatim. */
function approvedCrisisCopy(slot: ImmediateResourceSlot): Renderable {
  return [
    p({ class: 'crisis-banner' }, CRISIS_BANNER_COMPACT),
    h3({}, CRISIS_ENTRY_HEADING),
    p({}, CRISIS_ENTRY_DANGER),
    p({}, CRISIS_ENTRY_NOT_EMERGENCY),
    p({}, CRISIS_ENTRY_LIFELINE),
    ul(
      { class: 'card-grid' },
      slot.resources.map((resource) =>
        li({}, a({ class: 'card action', href: resource.destination }, resource.label)),
      ),
    ),
    p({ class: 'muted' }, CRISIS_FOOTER),
  ];
}

/**
 * Card headings take the level their container implies.
 *
 * A card sitting directly under the page `h1` must be an `h2`; the same card
 * inside a titled section is an `h3`. Skipping a level is a real 1.3.1 failure,
 * so the level is a parameter rather than a fixed tag.
 */
type HeadingLevel = 2 | 3;

function cardHeading(level: HeadingLevel, ...children: Renderable[]): Renderable {
  return level === 2 ? h2({}, ...children) : h3({}, ...children);
}

/** A category card. Non-operational cards are visible and labelled as such. */
function categoryCard(card: CategoryCard, level: HeadingLevel): Renderable {
  const operational = card.disposition === 'OPERATIONAL';
  return li(
    {},
    a(
      {
        class: operational ? 'card' : 'card card-unavailable',
        // Operational and non-operational cards share one route. The handler
        // decides what a category may show; a separate `/info` path would be a
        // second place for that rule to live, and it was a 404.
        href: `/app/resources/${card.label.toLowerCase().replace(/ /g, '-')}`,
      },
      cardHeading(level, card.label),
      operational
        ? undefined
        : // 1.4.1: availability is stated in text, not implied by the muted card.
          span(
            { class: 'badge' },
            card.disposition === 'COMING_SOON' ? 'Coming soon' : 'Info only',
          ),
      card.note === undefined ? undefined : p({ class: 'muted' }, card.note),
    ),
  );
}

function categoryGrid(cards: readonly CategoryCard[], level: HeadingLevel = 3): Renderable {
  return ul(
    { class: 'card-grid' },
    cards.map((card) => categoryCard(card, level)),
  );
}

/** The QRF status block plus its truthful affordances. §7.2. */
function qrfCard(model: QrfCardViewModel): Renderable {
  const presentation = presentQrfState(model.facts);
  const affordances = contactAffordances({
    state: presentation.state,
    authorizedVoicePath: model.authorizedVoicePath,
    authorizedMessagePath: model.authorizedMessagePath,
  });

  return section(
    { 'aria-labelledby': 'qrf-status' },
    h2({ id: 'qrf-status' }, 'Your QRF request'),
    stateBlock(presentation.state.replace(/_/g, ' '), presentation.headline),
    // Call and Message exist only with an authorized path (§7.2). An
    // unauthorized path renders nothing rather than a disabled control.
    // `/app/qrf/call` and `/app/qrf/message` have no handler. The live home
    // keeps both flags false so these hrefs do not render as dead product routes.
    affordances.call ? a({ class: 'action-secondary', href: '/app/qrf/call' }, 'Call') : undefined,
    affordances.message
      ? a({ class: 'action-secondary', href: '/app/qrf/message' }, 'Message')
      : undefined,
    presentation.cancellable
      ? form(
          { method: 'post', action: '/app/qrf/cancel' },
          button({ class: 'action-secondary', type: 'submit' }, 'Cancel request'),
        )
      : undefined,
  );
}

export function renderLanding(model: LandingViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'Shut Up and Serve'),
    // §7.4: mission framing without statistics or clinical efficacy claims.
    p({}, model.missionLine),
    ol(
      { class: 'loop', 'aria-label': 'Canonical support loop' },
      CANONICAL_LOOP.map((step) => li({}, step)),
    ),
    section(
      { 'aria-labelledby': 'take-action' },
      // §3.1 / §5: the action block is immediate and dominant.
      h2({ id: 'take-action', class: 'kicker' }, 'TAKE ACTION'),
      a({ class: 'action', href: '/app/join?role=veteran' }, 'I NEED SUPPORT'),
      a({ class: 'action', href: '/app/join?role=responder' }, 'I WANT TO SERVE'),
    ),
  ]);
  return assertSurface('LANDING', markup);
}

export function renderEnrollment(model: EnrollmentViewModel): string {
  const role = model.selectedRole ?? 'veteran';
  const markup = document(model.shell, [
    h1({}, 'Join the Mission'),
    section(
      { 'aria-labelledby': 'role' },
      h2({ id: 'role' }, 'Choose your role'),
      a({ class: 'action', href: '/app/join?role=veteran' }, 'Veteran'),
      a({ class: 'action', href: '/app/join?role=responder' }, 'Responder or Peer Counselor'),
    ),
    section(
      { 'aria-labelledby': 'contact' },
      h2({ id: 'contact' }, 'How we reach you'),
      // §7.1: replaces the reference's "No email" promise with the truth.
      p({}, model.contactChannelRequirement),
      // 3.3.2 labels; 1.3.5 autocomplete.
      model.authEnabled === true
        ? form(
            { method: 'post', action: '/app/auth/challenges' },
            input({ type: 'hidden', name: 'role', value: role }),
            label({ for: 'contact-channel' }, 'Email address'),
            input({
              id: 'contact-channel',
              name: 'destination',
              type: 'email',
              autocomplete: 'email',
              required: true,
            }),
            button({ class: 'action', type: 'submit' }, 'Send sign-in code'),
          )
        : p({ class: 'muted' }, 'Email sign-in is not available in this environment.'),
    ),
  ]);
  return assertSurface('ENROLLMENT', markup);
}

export function renderEmailOtp(model: EmailOtpViewModel): string {
  return document(model.shell, [
    h1({}, 'Check your email'),
    p(
      {},
      'If this address is enrolled, we sent a one-time sign-in code. The same message is shown for every address.',
    ),
    model.error === undefined ? undefined : p({ class: 'error' }, model.error),
    form(
      { method: 'post', action: '/app/auth/verify' },
      input({ type: 'hidden', name: 'destination', value: model.destination }),
      input({ type: 'hidden', name: 'role', value: model.selectedRole }),
      label({ for: 'sign-in-code' }, 'Sign-in code'),
      input({
        id: 'sign-in-code',
        name: 'code',
        type: 'text',
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        required: true,
      }),
      button({ class: 'action', type: 'submit' }, 'Sign in'),
    ),
    a({ class: 'action-secondary', href: `/app/join?role=${model.selectedRole}` }, 'Start again'),
  ]);
}

export function renderVeteranHome(model: VeteranHomeViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'Support'),
    // §3.4 / §5: QRF is the dominant action on the veteran home.
    section(
      { 'aria-labelledby': 'qrf' },
      h2({ id: 'qrf' }, 'Peer support'),
      model.activeQrf === undefined
        ? form(
            { method: 'post', action: '/app/qrf/deploy' },
            button({ class: 'action', type: 'submit' }, 'Deploy QRF'),
            // §7.2: no proximity claim, no emergency implication.
            p(
              { class: 'muted' },
              'This sends a peer support request. It does not contact emergency services.',
            ),
          )
        : qrfCard(model.activeQrf),
    ),
    model.checkInLink === undefined
      ? undefined
      : section(
          { 'aria-labelledby': 'check-in' },
          h2({ id: 'check-in' }, 'Check-In'),
          a({ class: 'action-secondary', href: model.checkInLink.href }, model.checkInLink.label),
          p(
            { class: 'muted' },
            'Answer the published questionnaire. This is not a diagnosis. ' +
              'Fixture Support Signal scoring is not a clinical score.',
          ),
        ),
    model.notificationsHref === undefined
      ? undefined
      : section(
          { 'aria-labelledby': 'notifications' },
          h2({ id: 'notifications' }, 'Notifications'),
          a({ class: 'action-secondary', href: model.notificationsHref }, 'Open notifications'),
          p(
            { class: 'muted' },
            'Delivery status for messages addressed to you. Destinations and message bodies are not shown here.',
          ),
        ),
    model.consentsHref === undefined && model.trustedContactsHref === undefined
      ? undefined
      : section(
          { 'aria-labelledby': 'privacy' },
          h2({ id: 'privacy' }, 'Privacy'),
          model.consentsHref === undefined
            ? undefined
            : a({ class: 'action-secondary', href: model.consentsHref }, 'View consents'),
          model.trustedContactsHref === undefined
            ? undefined
            : a(
                { class: 'action-secondary', href: model.trustedContactsHref },
                'View trusted contacts',
              ),
          p(
            { class: 'muted' },
            'Consent grants and trusted-circle membership for your account. Invite channels are never listed here.',
          ),
        ),
    // §3.5 / §5: immediate resources sit above the broader catalog.
    immediateResources(model.safetyCopyMode),
    section(
      { 'aria-labelledby': 'categories' },
      h2({ id: 'categories' }, 'Find help'),
      categoryGrid(model.categories),
    ),
  ]);
  // An in-flight request replaces the deploy action with the request block, so
  // the surface is asserted against that state's required elements (§7.2).
  return assertSurface(
    'VETERAN_HOME',
    markup,
    model.activeQrf === undefined ? undefined : 'QRF_IN_FLIGHT',
  );
}

export function renderQrfRequest(model: QrfRequestViewModel): string {
  const markup = document(model.shell, [h1({}, 'QRF request'), qrfCard(model.qrf)]);
  return assertSurface('QRF_REQUEST', markup);
}

export function renderImmediateResources(
  shell: ShellViewModel,
  mode: SafetyCopyMode = 'placeholder_test_only',
): string {
  const markup = document(shell, [h1({}, 'Immediate Resources'), immediateResources(mode)]);
  return assertSurface('IMMEDIATE_RESOURCES', markup);
}

export function renderResourceCategories(model: ResourceCategoriesViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'Find help'),
    // Cards sit directly under the page heading here, so they are h2.
    categoryGrid(model.categories, 2),
  ]);
  return assertSurface('RESOURCE_CATEGORIES', markup);
}

/**
 * Render a resource's contact path.
 *
 * §8 "direct phone/email/web actions where allowed": with a recorded scheme
 * (P-13) the row offers a real `tel:`/`mailto:`/web action; `sanitizeUrl`
 * (html.ts) allow-lists exactly those schemes, so a hostile catalog value cannot
 * smuggle `javascript:`. Without a kind — or with `FREEFORM` — the value is shown
 * as text and no scheme is guessed, preserving the released behavior.
 */
function contactRow(value: string, kind: ResourceRowViewModel['contactMethodKind']): Renderable {
  switch (kind) {
    case 'PHONE':
      return a(
        { class: 'action-secondary', href: `tel:${value.replace(/\s+/g, '')}` },
        `Call: ${value}`,
      );
    case 'EMAIL':
      return a({ class: 'action-secondary', href: `mailto:${value}` }, `Email: ${value}`);
    case 'URL':
      return a({ class: 'action-secondary', href: value }, `Visit website: ${value}`);
    default:
      return p({}, `Contact: ${value}`);
  }
}

export function renderResourceList(model: ResourceListViewModel): string {
  const markup = document(model.shell, [
    // §8: strong category header first, then clear back navigation.
    // Heading-first reading order (1.3.2) so the category is announced before
    // the way out.
    h1({}, model.categoryLabel),
    a({ class: 'action-secondary', href: model.backHref }, 'Back'),
    model.rows.length === 0
      ? stateBlock('No listings', 'No verified resources are configured for this category yet.')
      : ul(
          { class: 'card-grid' },
          model.rows.map((row) =>
            li(
              { class: 'card' },
              cardHeading(2, row.name),
              row.coverage === undefined ? undefined : p({ class: 'muted' }, row.coverage),
              // §8: freshness truth is visible when known.
              p({}, span({ class: 'badge' }, `Verified: ${row.freshness}`)),
              row.staleWarning
                ? p({ class: 'muted' }, 'This listing may be out of date.')
                : undefined,
              row.hours === undefined ? undefined : p({}, `Hours: ${row.hours}`),
              row.cost === undefined ? undefined : p({}, `Cost: ${row.cost}`),
              // §8: offer a direct action when the catalog recorded the scheme
              // (P-13); otherwise show the value as text and guess nothing.
              row.contactMethod === undefined
                ? p({ class: 'muted' }, 'No contact method recorded.')
                : contactRow(row.contactMethod, row.contactMethodKind),
            ),
          ),
        ),
    // §8 / API.md §5: progressive loading rather than one unbounded list.
    model.nextCursor === undefined
      ? undefined
      : a(
          {
            class: 'action-secondary',
            href: `?cursor=${encodeURIComponent(model.nextCursor)}`,
          },
          'Show more listings',
        ),
  ]);
  return assertSurface('RESOURCE_LIST', markup);
}

function needRow(need: ActiveNeedViewModel, level: HeadingLevel = 3): Renderable {
  return li(
    { class: 'card' },
    cardHeading(level, need.category),
    p({}, span({ class: 'badge' }, need.caseStatus)),
    need.prioritySignalLevel === undefined
      ? undefined
      : p({}, span({ class: 'badge' }, `Priority ${need.prioritySignalLevel}`)),
    p({ class: 'muted' }, need.openedLabel),
    need.claimable === true
      ? form(
          { method: 'post', action: `/app/responder/cases/${need.caseId}/commands/claim` },
          button({ class: 'action', type: 'submit' }, 'Claim'),
        )
      : undefined,
    a({ class: 'action-secondary', href: `/app/responder/cases/${need.caseId}` }, 'Open case'),
  );
}

export function renderResponderCase(model: ResponderCaseViewModel): string {
  const logAction = `/app/responder/cases/${model.need.caseId}/commands/log-contact-attempt`;
  const markup = document(model.shell, [
    h1({}, 'Case'),
    a({ href: '/app/responder' }, 'Back'),
    ul({ class: 'card-grid' }, needRow(model.need, 2)),
    section(
      { 'aria-labelledby': 'contact-attempts' },
      h2({ id: 'contact-attempts' }, 'Contact attempts'),
      model.contactAttempts.length === 0
        ? p({ class: 'muted' }, 'No contact attempts recorded for this case.')
        : ul(
            {},
            model.contactAttempts.map((attempt) =>
              li({}, `${attempt.channel} · ${attempt.outcome} · ${attempt.attemptedAtLabel}`),
            ),
          ),
      model.canLogContact === true
        ? form(
            { method: 'post', action: logAction },
            h3({}, 'Log contact attempt'),
            fieldset(
              { class: 'check-in-options' },
              legend({}, 'Channel'),
              CONTACT_CHANNEL_OPTIONS.map((channel) => {
                const id = `channel-${channel}`;
                return label(
                  { for: id, class: 'option' },
                  input({
                    id,
                    type: 'radio',
                    name: 'channel',
                    value: channel,
                    ...(channel === 'PHONE' ? { checked: true } : {}),
                  }),
                  channel,
                );
              }),
            ),
            fieldset(
              { class: 'check-in-options' },
              legend({}, 'Outcome'),
              CONTACT_OUTCOME_OPTIONS.map((outcome) => {
                const id = `outcome-${outcome}`;
                return label(
                  { for: id, class: 'option' },
                  input({
                    id,
                    type: 'radio',
                    name: 'outcome',
                    value: outcome,
                    ...(outcome === 'PENDING' ? { checked: true } : {}),
                  }),
                  outcome,
                );
              }),
            ),
            button({ class: 'action', type: 'submit' }, 'Log contact attempt'),
          )
        : undefined,
    ),
    section(
      { 'aria-labelledby': 'service-requests' },
      h2({ id: 'service-requests' }, 'Service requests'),
      model.serviceRequests.length === 0
        ? p({ class: 'muted' }, 'No service requests on this case.')
        : ul(
            {},
            model.serviceRequests.map((request) =>
              li({}, `${request.category} · ${request.status}`),
            ),
          ),
      model.canCreateServiceRequest === true
        ? form(
            {
              method: 'post',
              action: `/app/responder/cases/${model.need.caseId}/service-requests`,
            },
            h3({}, 'Create service request'),
            fieldset(
              { class: 'check-in-options' },
              legend({}, 'Category'),
              SERVICE_CATEGORY_OPTIONS.map((category) => {
                const id = `category-${category}`;
                return label(
                  { for: id, class: 'option' },
                  input({
                    id,
                    type: 'radio',
                    name: 'category',
                    value: category,
                    ...(category === 'FOOD' ? { checked: true } : {}),
                  }),
                  category,
                );
              }),
            ),
            button({ class: 'action', type: 'submit' }, 'Create service request'),
          )
        : undefined,
    ),
  ]);
  return assertSurface('RESPONDER_CASE', markup);
}

export function renderResponderDashboard(model: ResponderDashboardViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'Responder'),
    // §9.1: on-duty is a primary landmark. G-I-30: it is not a stored fact,
    // so the block states unavailability rather than posting a 404 form.
    section(
      { 'aria-labelledby': 'duty' },
      h2({ id: 'duty' }, 'On Duty'),
      dutyUnavailability(model.duty),
    ),
    section(
      { 'aria-labelledby': 'unassigned' },
      h2({ id: 'unassigned' }, 'Unassigned'),
      (model.unassignedNeeds ?? []).length === 0
        ? p({ class: 'muted' }, 'No unassigned cases in this tenant.')
        : ul(
            { class: 'card-grid' },
            (model.unassignedNeeds ?? []).map((need) => needRow(need)),
          ),
      model.unassignedNextCursor === undefined
        ? undefined
        : a(
            {
              class: 'action-secondary',
              href: `?unassigned_cursor=${encodeURIComponent(model.unassignedNextCursor)}`,
            },
            'Show more unassigned',
          ),
    ),
    section(
      { 'aria-labelledby': 'needs' },
      h2({ id: 'needs' }, 'Active Needs'),
      model.activeNeeds.length === 0
        ? p({ class: 'muted' }, 'No active needs assigned to you.')
        : ul(
            { class: 'card-grid' },
            model.activeNeeds.map((need) => needRow(need)),
          ),
      model.activeNextCursor === undefined
        ? undefined
        : a(
            {
              class: 'action-secondary',
              href: `?active_cursor=${encodeURIComponent(model.activeNextCursor)}`,
            },
            'Show more active needs',
          ),
    ),
    section(
      { 'aria-labelledby': 'alerts' },
      h2({ id: 'alerts' }, 'Alerts'),
      model.alerts.length === 0
        ? p({ class: 'muted' }, 'No alerts.')
        : ul(
            {},
            model.alerts.map((alert) => li({}, alert)),
          ),
    ),
    // §9.3: Quick Resource Share covers released capabilities only.
    section(
      { 'aria-labelledby': 'quick-share' },
      h2({ id: 'quick-share' }, 'Quick Resource Share'),
      categoryGrid(model.quickShareCategories),
    ),
    section(
      { 'aria-labelledby': 'metrics' },
      h2({ id: 'metrics' }, 'Summary'),
      // §9: a metric with no released definition says so rather than showing 0.
      dl(
        {},
        model.metrics.flatMap((metric) => [
          dt({}, metric.label),
          dd(
            {},
            metric.state === 'AVAILABLE'
              ? (metric.value ?? '')
              : span({ class: 'muted' }, metric.reason ?? 'Not available'),
          ),
        ]),
      ),
    ),
  ]);
  return assertSurface('RESPONDER_DASHBOARD', markup);
}

export function renderResponderAvailability(model: ResponderAvailabilityViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'On Duty'),
    dutyUnavailability(model.duty),
    // D-009 coverage hours stay absent. A window here would invent hours.
  ]);
  return assertSurface('RESPONDER_AVAILABILITY', markup);
}

export function renderActiveNeeds(model: ActiveNeedsViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'Active Needs'),
    model.needs.length === 0
      ? p({ class: 'muted' }, 'No active needs assigned to you.')
      : ul(
          { class: 'card-grid' },
          model.needs.map((need) => needRow(need, 2)),
        ),
    model.nextCursor === undefined
      ? undefined
      : a(
          {
            class: 'action-secondary',
            href: `?cursor=${encodeURIComponent(model.nextCursor)}`,
          },
          'Show more active needs',
        ),
  ]);
  return assertSurface('ACTIVE_NEEDS', markup);
}

export function renderChat(model: ChatViewModel): string {
  const markup = document(model.shell, [
    h1({}, 'Chat'),
    model.availability.status === 'UNAVAILABLE'
      ? stateBlock('Unavailable', model.availability.reason)
      : model.availability.threads.length === 0
        ? // Reachable only once a caller declares messaging AVAILABLE, which
          // no released slice can truthfully do yet.
          p({ class: 'muted' }, 'You have no conversations yet.')
        : ul(
            { class: 'card-grid' },
            model.availability.threads.map((thread) =>
              li(
                { class: 'card' },
                cardHeading(2, thread.counterpartLabel),
                thread.lastMessagePreview === undefined
                  ? undefined
                  : p({ class: 'muted' }, thread.lastMessagePreview),
                a(
                  { class: 'action-secondary', href: `/app/chat/${thread.threadId}` },
                  'Open conversation',
                ),
              ),
            ),
          ),
  ]);
  return assertSurface('CHAT', markup);
}

export function renderAdminOverview(model: AdminOverviewViewModel): string {
  const providerHelp = details(
    { class: 'help-tip' },
    summary({}, 'What can I change here?'),
    p(
      { class: 'muted' },
      'Choose an accepted adapter for this tenant, set its routing coverage, or disable it. ' +
        'Disable removes it from new routing and keeps existing fulfillment history.',
    ),
  );

  const providerCatalog = model.providerCatalog.map((provider) =>
    option(
      { value: provider.adapterId },
      `${provider.label} · ${provider.capability} · ${provider.integrationMode}`,
    ),
  );

  const providerConfigurationCards = model.providerConfigurations.map((provider) => {
    const fieldKey = provider.adapterId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const helpId = `provider-help-${fieldKey}`;
    const isManual = provider.integrationMode === 'MANUAL_COORDINATION';
    return li(
      { class: 'card provider-card' },
      div(
        { class: 'provider-card-heading' },
        h3({}, provider.label),
        span({ class: 'badge' }, provider.enabled ? 'ENABLED' : 'DISABLED'),
      ),
      p({ class: 'muted' }, `${provider.capability} · ${provider.integrationMode}`),
      p({}, `Health: ${provider.health} · Credentials: ${provider.secretPresence}`),
      p(
        { class: 'muted' },
        provider.coverageCounties.length === 0
          ? 'Coverage: no county restriction recorded.'
          : `Coverage: ${provider.coverageCounties.join(', ')}`,
      ),
      p({ class: 'muted' }, `Routing priority: ${provider.routingPriority}`),
      details(
        { class: 'help-tip', id: helpId },
        summary({}, 'What does this status mean?'),
        p(
          { class: 'muted' },
          isManual
            ? 'Manual coordination is the required fallback for this capability and cannot be disabled.'
            : 'API adapters are accepted implementations. Missing credentials keep the adapter unavailable until deployment configuration is completed.',
        ),
      ),
      form(
        { class: 'provider-form', method: 'post', action: '/app/admin/providers/routing' },
        input({ type: 'hidden', name: 'adapter_id', value: provider.adapterId }),
        input({ type: 'hidden', name: 'capability', value: provider.capability }),
        label({ for: `coverage-${fieldKey}` }, 'Coverage counties'),
        input({
          id: `coverage-${fieldKey}`,
          type: 'text',
          name: 'coverage_counties',
          value: provider.coverageCounties.join(', '),
          placeholder: 'santa-clara, san-mateo',
          'aria-describedby': helpId,
        }),
        label({ for: `priority-${fieldKey}` }, 'Routing priority'),
        input({
          id: `priority-${fieldKey}`,
          type: 'number',
          name: 'routing_priority',
          value: provider.routingPriority,
          min: 0,
          max: 10000,
          required: true,
          'aria-describedby': helpId,
        }),
        button({ class: 'action-secondary', type: 'submit' }, 'Save routing'),
      ),
      isManual
        ? p({ class: 'muted' }, 'Required fallback. This adapter stays enabled.')
        : provider.enabled
          ? form(
              { class: 'provider-form', method: 'post', action: '/app/admin/providers/disable' },
              input({ type: 'hidden', name: 'adapter_id', value: provider.adapterId }),
              input({ type: 'hidden', name: 'capability', value: provider.capability }),
              button({ class: 'action-secondary', type: 'submit' }, 'Disable provider'),
            )
          : form(
              { class: 'provider-form', method: 'post', action: '/app/admin/providers/enable' },
              input({ type: 'hidden', name: 'adapter_id', value: provider.adapterId }),
              button({ class: 'action', type: 'submit' }, 'Enable provider'),
            ),
    );
  });

  const markup = document(model.shell, [
    // §7.5: explicit admin terminology, never the prototype's informal label.
    h1({}, 'SUAS Admin'),
    // §7.5 also asks that role/tenant scope be clearer than the prototype.
    p({}, span({ class: 'badge' }, `Scope: ${model.tenantLabel}`)),
    model.notice === undefined ? undefined : p({ class: 'state' }, model.notice),
    section(
      { 'aria-labelledby': 'capabilities' },
      h2({ id: 'capabilities' }, 'Capabilities'),
      // Presence only. No credential value ever reaches an admin surface.
      dl(
        {},
        model.capabilities.flatMap((capability) => [
          dt({}, capability.name),
          dd(
            {},
            span({ class: 'badge' }, capability.presence),
            capability.note === undefined
              ? undefined
              : span({ class: 'muted' }, ` ${capability.note}`),
          ),
        ]),
      ),
    ),
    section(
      { 'aria-labelledby': 'provider-controls' },
      h2({ id: 'provider-controls' }, 'Provider controls'),
      p(
        {},
        'Enable accepted provider adapters for this tenant. “Disable” removes an adapter from new routing; it does not delete history.',
      ),
      providerHelp,
      form(
        {
          class: 'provider-form provider-enable-form',
          method: 'post',
          action: '/app/admin/providers/enable',
        },
        label({ for: 'provider-adapter' }, 'Accepted provider'),
        select({ id: 'provider-adapter', name: 'adapter_id', required: true }, [
          option({ value: '', disabled: true, selected: true }, 'Choose a provider'),
          providerCatalog,
        ]),
        p(
          { class: 'field-note' },
          'The catalog is fixed by released decisions. API adapters with missing credentials will be refused safely.',
        ),
        button({ class: 'action', type: 'submit' }, 'Enable provider'),
      ),
      model.providerConfigurations.length === 0
        ? stateBlock(
            'No provider configurations',
            'No accepted provider adapter is configured for this tenant yet.',
          )
        : ul({ class: 'card-grid provider-grid' }, providerConfigurationCards),
    ),
    section(
      { 'aria-labelledby': 'blocking' },
      h2({ id: 'blocking' }, 'Open decisions'),
      model.blockingDecisions.length === 0
        ? p({ class: 'muted' }, 'None recorded.')
        : ul(
            {},
            model.blockingDecisions.map((decision) => li({}, decision)),
          ),
    ),
    section(
      { 'aria-labelledby': 'readiness' },
      h2({ id: 'readiness' }, 'Readiness'),
      p({}, model.readiness),
    ),
  ]);
  return assertSurface('ADMIN_OVERVIEW', markup);
}

/**
 * Consent grant list for the authenticated veteran. Not in MVP_REFERENCE.md §5.
 */
export function renderConsentsList(model: ConsentsListViewModel): string {
  return document(model.shell, [
    h1({}, 'Consents'),
    a({ class: 'action-secondary', href: '/app/home' }, 'Back to Support'),
    p(
      { class: 'muted' },
      'Grants you have issued. Membership in a trusted circle is not a permission.',
    ),
    model.grants.length === 0
      ? p({ class: 'muted' }, 'No consent grants on file.')
      : ul(
          { class: 'card-grid' },
          model.grants.map((grant) =>
            li(
              { class: 'card' },
              h2({}, grant.permission),
              p({}, span({ class: 'badge' }, grant.status)),
              p({ class: 'muted' }, `${grant.scope} · ${grant.granteeType}`),
              p({ class: 'muted' }, grant.purpose),
              p({ class: 'muted' }, `Granted ${grant.grantedAtLabel}`),
              grant.expiresAtLabel === undefined
                ? undefined
                : p({ class: 'muted' }, `Expires ${grant.expiresAtLabel}`),
            ),
          ),
        ),
  ]);
}

/**
 * Trusted-circle roster for the authenticated veteran. Not in §5 inventory.
 * Invite email/phone never appear (TRUSTED_CIRCLE.md / PRIVACY.md).
 */
export function renderTrustedContactsList(model: TrustedContactsListViewModel): string {
  return document(model.shell, [
    h1({}, 'Trusted contacts'),
    a({ class: 'action-secondary', href: '/app/home' }, 'Back to Support'),
    p(
      { class: 'muted' },
      'People in your trusted circle. Accepting an invite does not grant consent. Invite channels are not shown.',
    ),
    model.contacts.length === 0
      ? p({ class: 'muted' }, 'No trusted contacts on file.')
      : ul(
          { class: 'card-grid' },
          model.contacts.map((contact) =>
            li(
              { class: 'card' },
              h2({}, contact.relationshipLabel),
              p({}, span({ class: 'badge' }, contact.status)),
            ),
          ),
        ),
  ]);
}

/**
 * Recipient notification inbox. Not in the MVP_REFERENCE.md §5 inventory, so
 * this does not call `assertRequiredElementsPresent`. Public fields only.
 */
export function renderNotificationsInbox(model: NotificationsInboxViewModel): string {
  return document(model.shell, [
    h1({}, 'Notifications'),
    a({ class: 'action-secondary', href: '/app/home' }, 'Back to Support'),
    model.preferencesHref === undefined
      ? undefined
      : a({ class: 'action-secondary', href: model.preferencesHref }, 'Channel preferences'),
    p(
      { class: 'muted' },
      `Showing up to ${model.limit} recent notifications. Destinations and message bodies are never listed.`,
    ),
    model.notifications.length === 0
      ? p({ class: 'muted' }, 'No notifications yet.')
      : ul(
          { class: 'card-grid' },
          model.notifications.map((row) =>
            li(
              { class: 'card' },
              h2({}, row.reason),
              p({}, span({ class: 'badge' }, row.deliveryStatus)),
              p({ class: 'muted' }, `${row.channel} · attempts ${row.attemptCount}`),
              row.sentAtLabel === undefined
                ? undefined
                : p({ class: 'muted' }, `Sent ${row.sentAtLabel}`),
              row.subjectType === undefined
                ? undefined
                : p({ class: 'muted' }, `About ${row.subjectType}`),
            ),
          ),
        ),
  ]);
}

/**
 * Channel preference controls. Preferences never grant consent (§4.4).
 */
export function renderNotificationPreferences(model: NotificationPreferencesViewModel): string {
  return document(model.shell, [
    h1({}, 'Channel preferences'),
    a({ class: 'action-secondary', href: '/app/notifications' }, 'Back to notifications'),
    p(
      { class: 'muted' },
      'These settings only choose delivery channels. They do not grant consent and cannot authorize a send.',
    ),
    ul(
      { class: 'card-grid' },
      model.preferences.map((pref) =>
        li(
          { class: 'card' },
          h2({}, pref.channel),
          p({}, span({ class: 'badge' }, pref.enabled ? 'Enabled' : 'Disabled')),
          form(
            { method: 'post', action: '/app/notifications/preferences' },
            input({ type: 'hidden', name: 'channel', value: pref.channel }),
            input({
              type: 'hidden',
              name: 'enabled',
              value: pref.enabled ? 'false' : 'true',
            }),
            button(
              { class: 'action', type: 'submit' },
              pref.enabled ? `Disable ${pref.channel}` : `Enable ${pref.channel}`,
            ),
          ),
        ),
      ),
    ),
  ]);
}

/**
 * Start or resume a Check-In. Not in the MVP_REFERENCE.md §5 inventory, so this
 * does not call `assertRequiredElementsPresent`.
 */
export function renderCheckInStart(model: CheckInStartViewModel): string {
  const inProgress = model.inProgressHref !== undefined;
  return document(model.shell, [
    h1({}, 'Check-In'),
    p(
      {},
      'Answer the published questionnaire. This is not a diagnosis and does not ' +
        'contact emergency services.',
    ),
    p(
      { class: 'muted' },
      model.supportSignalMode === 'disabled'
        ? 'Support Signal scoring is disabled in this environment. That is not a clinical score.'
        : 'Support Signal scoring in this environment is fixture mode. That is not a clinical score.',
    ),
    inProgress
      ? p({}, 'You have a Check-In in progress. Continue to pick up where you left off.')
      : undefined,
    form(
      { method: 'post', action: '/app/check-ins' },
      button(
        { class: 'action', type: 'submit' },
        inProgress ? 'Continue Check-In' : 'Start Check-In',
      ),
    ),
    inProgress
      ? a(
          { class: 'action-secondary', href: model.inProgressHref ?? '/app/check-ins' },
          'Open Check-In',
        )
      : undefined,
    a({ class: 'action-secondary', href: '/app/home' }, 'Back to Support'),
  ]);
}

/**
 * One unanswered question, a complete action, or a truthful settled result.
 *
 * Not in the MVP_REFERENCE.md §5 inventory.
 */
export function renderCheckInSession(model: CheckInSessionViewModel): string {
  const question = model.currentQuestion;
  const result = model.result;
  const saveAction = `/app/check-ins/${model.checkInId}/responses`;
  const completeAction = `/app/check-ins/${model.checkInId}/commands/complete`;

  return document(model.shell, [
    h1({}, 'Check-In'),
    p({}, span({ class: 'badge' }, model.status)),
    p({ class: 'muted' }, `Questionnaire ${model.questionnaireVersion}`),
    result === undefined
      ? undefined
      : stateBlock(result.statusLabel, result.headline, result.detail),
    question === undefined
      ? undefined
      : [
          model.questionIndex === undefined || model.questionCount === undefined
            ? undefined
            : p({ class: 'muted' }, `Question ${model.questionIndex} of ${model.questionCount}`),
          form(
            { method: 'post', action: saveAction },
            input({ type: 'hidden', name: 'question_id', value: question.questionId }),
            fieldset(
              { class: 'check-in-options' },
              legend({}, question.prompt),
              question.required ? p({}, span({ class: 'badge' }, 'Required')) : undefined,
              question.options.map((option) => {
                const optionId = `option-${option.answerOptionId}`;
                return label(
                  { for: optionId, class: 'option' },
                  input({
                    id: optionId,
                    type: 'radio',
                    name: 'answer_option_id',
                    value: option.answerOptionId,
                    required: true,
                  }),
                  option.label,
                );
              }),
            ),
            button({ class: 'action', type: 'submit' }, 'Save answer'),
          ),
        ],
    model.canComplete
      ? [
          h2({}, 'Finish this Check-In'),
          form(
            { method: 'post', action: completeAction },
            button({ class: 'action-secondary', type: 'submit' }, 'Complete Check-In'),
          ),
          p(
            { class: 'muted' },
            'Completing without every required answer marks this Check-In incomplete. ' +
              'No Support Signal is computed from an incomplete Check-In.',
          ),
        ]
      : undefined,
    a({ class: 'action-secondary', href: '/app/home' }, 'Back to Support'),
  ]);
}

/** Render the persistent nav on its own, for the §11 fixture that covers it. */
export function renderMobileNav(shell: ShellViewModel): string {
  const markup = render(mobileNav(shell));
  return assertSurface('MOBILE_NAV', markup);
}

function assertSurface(id: SurfaceId, markup: string, variant?: string): string {
  assertRequiredElementsPresent(id, markup, variant);
  return markup;
}
