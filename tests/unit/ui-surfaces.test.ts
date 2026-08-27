/**
 * Rendered-surface evidence.
 *
 * SUAS-specs MVP_REFERENCE.md §2 (no required element may silently disappear),
 * §4 (product principles), §7 (mandatory divergences), §8 (resource fidelity),
 * §9 (no fabricated metrics), §10 (WCAG 2.2 AA), §11 (deterministic fixtures).
 */

import { describe, expect, it } from 'vitest';
import {
  assertRequiredElementsPresent,
  auditAccessibility,
  CATEGORY_CARDS,
  containsForbiddenCrisisPhrase,
  CRISIS_ENTRY_HEADING,
  CRISIS_ENTRY_NOT_EMERGENCY,
  DUTY_UNAVAILABLE_REASON,
  MissingRequiredElementError,
  presentCheckInResult,
  renderActiveNeeds,
  renderChat,
  renderConsentsList,
  renderTrustedContactsList,
  renderCheckInSession,
  renderCheckInStart,
  renderEnrollment,
  renderImmediateResources,
  renderNotificationsInbox,
  renderResourceList,
  renderResponderAvailability,
  renderResponderCase,
  renderResponderDashboard,
  renderVeteranHome,
  UnknownSurfaceStateError,
  VISUAL_FIXTURES,
} from '../../src/ui/index.js';

const shell = {
  title: 'Support',
  viewport: 'MOBILE',
  showMobileNav: true,
} as const;

describe('MVP_REFERENCE.md §11 — fixtures are deterministic', () => {
  it.each(VISUAL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s renders identically on repeated calls',
    (_id, fixture) => {
      expect(fixture.render()).toBe(fixture.render());
    },
  );

  it('renders every fixture without a clock, database, or network', () => {
    // Determinism above would not catch a fixture that throws on the first call.
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.render().length, fixture.id).toBeGreaterThan(0);
    }
  });
});

describe('MVP_REFERENCE.md §10 — accessibility floor', () => {
  it.each(VISUAL_FIXTURES.map((fixture) => [fixture.id, fixture] as const))(
    '%s has no decidable WCAG 2.2 AA failure',
    (_id, fixture) => {
      const findings = auditAccessibility(fixture.render(), fixture.markupKind);
      expect(
        findings,
        findings.map((finding) => `${finding.criterion}: ${finding.message}`).join('\n'),
      ).toEqual([]);
    },
  );

  it('detects a missing label rather than passing everything', () => {
    // Evidence that the audit can fail: a control with no accessible name.
    const findings = auditAccessibility('<a href="/x"></a>', 'FRAGMENT');
    expect(findings.map((finding) => finding.criterion)).toContain('4.1.2 Name, Role, Value');
  });

  it('detects a viewport that blocks zoom', () => {
    const markup =
      '<html lang="en"><head><meta name="viewport" content="width=device-width,user-scalable=no">' +
      '</head><body><main><h1>x</h1></main><a class="skip-link" href="#main">Skip</a></body></html>';
    const findings = auditAccessibility(markup, 'DOCUMENT');
    expect(findings.map((finding) => finding.criterion)).toContain('1.4.4 Resize Text');
  });
});

describe('MVP_REFERENCE.md §2 — required elements cannot silently disappear', () => {
  it('fails when a reference-critical action is missing', () => {
    expect(() => assertRequiredElementsPresent('LANDING', '<h1>Shut Up and Serve</h1>')).toThrow(
      MissingRequiredElementError,
    );
  });

  it('names which elements went missing', () => {
    try {
      assertRequiredElementsPresent('LANDING', '<h1>TAKE ACTION</h1>');
      expect.unreachable('expected a missing-element failure');
    } catch (error) {
      expect((error as MissingRequiredElementError).missing).toEqual([
        'I NEED SUPPORT',
        'I WANT TO SERVE',
      ]);
    }
  });
});

describe('MVP_REFERENCE.md §6 — non-operational cards stay visible and inert', () => {
  const markup = renderVeteranHome({ shell, categories: CATEGORY_CARDS });

  it('keeps every reference category label on the veteran home', () => {
    for (const card of CATEGORY_CARDS) {
      expect(markup, card.label).toContain(card.label);
    }
  });

  it('labels unreleased categories in text, not by styling alone', () => {
    expect(markup).toContain('Coming soon');
    expect(markup).toContain('Info only');
  });

  it('states that a non-operational card creates no request', () => {
    expect(markup).toContain('does not create a request');
  });
});

describe('MVP_REFERENCE.md §7.2 — the veteran home is truthful about QRF', () => {
  const markup = renderVeteranHome({ shell, categories: CATEGORY_CARDS });

  it('offers the deploy action as the dominant veteran action', () => {
    expect(markup).toContain('Deploy QRF');
  });

  it('does not imply emergency dispatch', () => {
    expect(markup).toContain('does not contact emergency services');
  });

  it('makes no proximity claim', () => {
    for (const phrase of ['near you', 'nearby', 'closest']) {
      expect(markup.toLowerCase(), phrase).not.toContain(phrase);
    }
  });

  it('places immediate resources above the broader catalog', () => {
    expect(markup.indexOf('Immediate Resources')).toBeLessThan(markup.indexOf('Find help'));
  });

  it('keeps the default crisis slot as a placeholder', () => {
    expect(markup).toContain('not available in this build');
    expect(markup).not.toMatch(/\b988\b/);
  });

  it('shows Pages chrome without adding a Check-In surface to the §11 fixture', () => {
    expect(markup).toContain('zer0state');
    expect(markup).toContain('SPEC-017 · NOT READY');
    expect(markup).toContain('Deploy QRF');
    expect(markup).not.toContain('Check-in');
    expect(markup).not.toContain('Check-In');
  });

  it('offers a truthful Check-In link when the live home supplies one', () => {
    const withLink = renderVeteranHome({
      shell,
      categories: CATEGORY_CARDS,
      checkInLink: { href: '/app/check-ins', label: 'Start a Check-In' },
    });
    expect(withLink).toContain('href="/app/check-ins"');
    expect(withLink).toContain('Start a Check-In');
    expect(withLink).toContain('not a diagnosis');
    expect(withLink).toContain('not a clinical score');
    const main = /<main[\s\S]*<\/main>/.exec(withLink)?.[0] ?? '';
    expect(main.toLowerCase()).not.toContain('transition');
    expect(auditAccessibility(withLink)).toEqual([]);
  });
});

describe('SAFETY_COPY.md §1 / MVP_REFERENCE.md §7.3 — approved crisis copy', () => {
  const approvedHome = renderVeteranHome({
    shell,
    categories: CATEGORY_CARDS,
    safetyCopyMode: 'approved',
  });
  const approvedSlot = renderImmediateResources(shell, 'approved');

  it('renders the released 911/988 actions as tel: destinations', () => {
    for (const page of [approvedHome, approvedSlot]) {
      expect(page).toContain('href="tel:911"');
      expect(page).toContain('href="tel:988"');
      expect(page).toContain('Call 911');
      expect(page).toContain('Call or text 988');
    }
  });

  it('renders the released crisis-entry wording', () => {
    expect(approvedSlot).toContain(CRISIS_ENTRY_HEADING);
    expect(approvedSlot).toContain(CRISIS_ENTRY_NOT_EMERGENCY);
    expect(approvedSlot).toContain('988 Suicide &amp; Crisis Lifeline');
  });

  it('does not emit a forbidden crisis phrase', () => {
    expect(containsForbiddenCrisisPhrase(approvedHome)).toBeUndefined();
    expect(containsForbiddenCrisisPhrase(approvedSlot)).toBeUndefined();
  });

  it('stays accessible in approved mode', () => {
    expect(auditAccessibility(approvedHome)).toEqual([]);
    expect(auditAccessibility(approvedSlot)).toEqual([]);
  });
});

describe('MVP_REFERENCE.md §7.2 — the veteran home with a request in flight', () => {
  const inFlight = {
    shell,
    categories: CATEGORY_CARDS,
    activeQrf: {
      facts: {
        requestStatus: 'MATCHING',
        responderAssigned: false,
        responderNotificationDelivered: false,
        coordinationDegraded: false,
        matchingExhausted: false,
      },
      authorizedVoicePath: false,
      authorizedMessagePath: false,
    },
  } as const;

  it('renders instead of failing its own required-element assert', () => {
    // The deploy action is legitimately replaced once a request exists; before
    // the state variant existed this threw and the live route returned 500.
    expect(() => renderVeteranHome(inFlight)).not.toThrow();
  });

  it('replaces the deploy action with the request block in the same position', () => {
    const markup = renderVeteranHome(inFlight);
    expect(markup).toContain('Your QRF request');
    // Offering a second deploy while one is in flight would be wrong.
    expect(markup).not.toContain('Deploy QRF');
  });

  it('keeps every other §5 landmark the default state requires', () => {
    const markup = renderVeteranHome(inFlight);
    for (const element of ['Immediate Resources', 'Housing', 'Food']) {
      expect(markup, element).toContain(element);
    }
  });

  it('refuses a surface state that declares no required elements', () => {
    expect(() => assertRequiredElementsPresent('VETERAN_HOME', '<p>x</p>', 'INVENTED')).toThrow(
      UnknownSurfaceStateError,
    );
  });
});

describe('MVP_REFERENCE.md §8 — resource screens', () => {
  it('links Show more when the catalog page continues', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [{ id: 'r1', name: 'Example Pantry', freshness: 'FRESH', staleWarning: false }],
      nextCursor: 'cursor-food-2',
    });
    expect(markup).toContain('href="?cursor=cursor-food-2"');
    expect(markup).toContain('Show more listings');
  });

  it('says so when no contact method is recorded', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [{ id: 'r1', name: 'Example Pantry', freshness: 'UNVERIFIED', staleWarning: true }],
    });
    expect(markup).toContain('No contact method recorded.');
  });

  it('never guesses a tel: or mailto: scheme from the unstructured field', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'r1',
          name: 'Example Pantry',
          contactMethod: 'Phone +1-555-555-0101',
          freshness: 'FRESH',
          staleWarning: false,
        },
      ],
    });
    expect(markup).not.toContain('tel:');
    expect(markup).not.toContain('mailto:');
  });

  it('offers a direct tel: action when the catalog records a PHONE scheme (P-13)', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'r1',
          name: 'Example Pantry',
          contactMethod: '+1-555-555-0101',
          contactMethodKind: 'PHONE',
          freshness: 'FRESH',
          staleWarning: false,
        },
      ],
    });
    expect(markup).toContain('href="tel:+1-555-555-0101"');
    expect(markup).toContain('Call:');
  });

  it('offers a mailto: action for an EMAIL scheme and a web link for a URL scheme (P-13)', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'r1',
          name: 'Example Meals',
          contactMethod: 'meals@example.org',
          contactMethodKind: 'EMAIL',
          freshness: 'FRESH',
          staleWarning: false,
        },
        {
          id: 'r2',
          name: 'Example Web Intake',
          contactMethod: 'https://example.org/intake',
          contactMethodKind: 'URL',
          freshness: 'FRESH',
          staleWarning: false,
        },
      ],
    });
    expect(markup).toContain('href="mailto:meals@example.org"');
    expect(markup).toContain('href="https://example.org/intake"');
  });

  it('renders a FREEFORM contact as text and guesses no scheme (P-13)', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'r1',
          name: 'Example Pantry',
          contactMethod: 'Walk in during posted hours',
          contactMethodKind: 'FREEFORM',
          freshness: 'FRESH',
          staleWarning: false,
        },
      ],
    });
    expect(markup).toContain('Contact: Walk in during posted hours');
    expect(markup).not.toContain('tel:');
    expect(markup).not.toContain('mailto:');
  });

  it('defangs a hostile URL scheme rather than rendering an executable action (P-13)', () => {
    // Constructed so the source carries no literal script-url token.
    const hostile = `java${'script'}:alert(1)`;
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [
        {
          id: 'r1',
          name: 'Example Hostile',
          contactMethod: hostile,
          contactMethodKind: 'URL',
          freshness: 'FRESH',
          staleWarning: false,
        },
      ],
    });
    // The href is neutralized to '#'; the raw value never reaches a live href.
    expect(markup).not.toContain(`href="${hostile}"`);
    expect(markup).toContain('href="#"');
  });

  it('shows a truthful empty state rather than an empty page', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Transportation',
      backHref: '/app/resources',
      rows: [],
    });
    expect(markup).toContain('No verified resources are configured');
  });

  it('keeps back navigation', () => {
    const markup = renderResourceList({
      shell,
      categoryLabel: 'Food',
      backHref: '/app/resources',
      rows: [],
    });
    expect(markup).toContain('Back');
    expect(markup.indexOf('<h1>Food</h1>')).toBeLessThan(markup.indexOf('>Back</a>'));
  });
});

describe('MVP_REFERENCE.md §9 — no fabricated responder metrics', () => {
  const markup = renderResponderDashboard({
    shell,
    duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
    activeNeeds: [],
    alerts: [],
    quickShareCategories: [],
    metrics: [
      { label: 'Responses', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
      { label: 'Avg Response', state: 'NOT_COMPUTABLE', reason: 'No released definition' },
    ],
  });

  it('states why a metric is unavailable instead of showing a zero', () => {
    expect(markup).toContain('No released definition');
    expect(markup).not.toMatch(/<dd[^>]*>\s*0\s*<\/dd>/);
  });

  it('keeps the §9 emphasis blocks present', () => {
    for (const block of ['On Duty', 'Active Needs', 'Alerts', 'Quick Resource Share']) {
      expect(markup, block).toContain(block);
    }
  });
});

describe('API.md §5 — responder HTML queue cursors', () => {
  it('links Show more when unassigned or active pages continue', () => {
    const markup = renderResponderDashboard({
      shell,
      duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
      unassignedNeeds: [
        {
          caseId: 'case-u1',
          caseStatus: 'OPEN',
          category: 'Support Case',
          openedLabel: 'Opened',
          claimable: true,
        },
      ],
      unassignedNextCursor: 'cursor-unassigned-2',
      activeNeeds: [
        {
          caseId: 'case-a1',
          caseStatus: 'ASSIGNED',
          category: 'Support Case',
          openedLabel: 'Opened',
        },
      ],
      activeNextCursor: 'cursor-active-2',
      alerts: [],
      quickShareCategories: [],
      metrics: [],
    });
    expect(markup).toContain('href="?unassigned_cursor=cursor-unassigned-2"');
    expect(markup).toContain('Show more unassigned');
    expect(markup).toContain('href="?active_cursor=cursor-active-2"');
    expect(markup).toContain('Show more active needs');
  });

  it('omits Show more when the page is complete', () => {
    const markup = renderResponderDashboard({
      shell,
      duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
      unassignedNeeds: [],
      activeNeeds: [],
      alerts: [],
      quickShareCategories: [],
      metrics: [],
    });
    expect(markup).not.toContain('Show more unassigned');
    expect(markup).not.toContain('Show more active needs');
    expect(markup).not.toContain('unassigned_cursor=');
    expect(markup).not.toContain('active_cursor=');
  });

  it('links Show more on the dedicated Active Needs surface', () => {
    const markup = renderActiveNeeds({
      shell,
      needs: [
        {
          caseId: 'case-a1',
          caseStatus: 'ACTIVE',
          category: 'Support Case',
          openedLabel: 'Opened',
        },
      ],
      nextCursor: 'cursor-needs-2',
    });
    expect(markup).toContain('href="?cursor=cursor-needs-2"');
    expect(markup).toContain('Show more active needs');
  });
});

describe('MVP_REFERENCE.md §9 / G-I-30 — on-duty is not a recorded fact', () => {
  const dashboard = renderResponderDashboard({
    shell,
    duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
    activeNeeds: [],
    alerts: [],
    quickShareCategories: [],
    metrics: [],
  });
  const availability = renderResponderAvailability({
    shell: { title: 'On Duty', viewport: 'MOBILE', showMobileNav: true },
    duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
  });

  it('keeps the On Duty landmark on both responder surfaces', () => {
    expect(dashboard).toContain('On Duty');
    expect(availability).toContain('On Duty');
  });

  it('states unavailability rather than posting a duty change', () => {
    for (const markup of [dashboard, availability]) {
      expect(markup).toContain(DUTY_UNAVAILABLE_REASON);
      expect(markup).toContain('Unavailable');
      expect(markup).not.toContain('action="/app/responder/availability"');
      expect(markup).not.toContain('Go on duty');
      expect(markup).not.toContain('Go off duty');
    }
  });

  it('does not claim that the responder is or is not receiving requests', () => {
    for (const markup of [dashboard, availability]) {
      expect(markup).not.toContain('You are receiving requests.');
      expect(markup).not.toContain('You are not receiving requests.');
    }
  });
});

describe('Responder case HTML lists contact and service requests', () => {
  it('posts Create service request only when canCreateServiceRequest', () => {
    const withForm = renderResponderCase({
      shell,
      need: {
        caseId: 'case-open',
        caseStatus: 'ASSIGNED',
        category: 'Support Case',
        openedLabel: 'Opened',
      },
      contactAttempts: [],
      serviceRequests: [],
      canCreateServiceRequest: true,
    });
    expect(withForm).toContain('action="/app/responder/cases/case-open/service-requests"');
    expect(withForm).toContain('Create service request');
    expect(withForm).toContain('name="category"');
    expect(auditAccessibility(withForm)).toEqual([]);

    const without = renderResponderCase({
      shell,
      need: {
        caseId: 'case-closed',
        caseStatus: 'CLOSED',
        category: 'Support Case',
        openedLabel: 'Opened',
      },
      contactAttempts: [],
      serviceRequests: [],
    });
    expect(without).not.toContain('action="/app/responder/cases/case-closed/service-requests"');
    expect(without).not.toContain('Create service request');
  });

  it('posts Log contact attempt only when canLogContact', () => {
    const withForm = renderResponderCase({
      shell,
      need: {
        caseId: 'case-claimed',
        caseStatus: 'ASSIGNED',
        category: 'Support Case',
        openedLabel: 'Opened',
      },
      contactAttempts: [],
      serviceRequests: [],
      canLogContact: true,
    });
    expect(withForm).toContain(
      'action="/app/responder/cases/case-claimed/commands/log-contact-attempt"',
    );
    expect(withForm).toContain('Log contact attempt');
    expect(withForm).toContain('name="channel"');
    expect(withForm).toContain('name="outcome"');
    expect(auditAccessibility(withForm)).toEqual([]);

    const without = renderResponderCase({
      shell,
      need: {
        caseId: 'case-open',
        caseStatus: 'OPEN',
        category: 'Support Case',
        openedLabel: 'Opened',
        claimable: true,
      },
      contactAttempts: [],
      serviceRequests: [],
    });
    expect(without).not.toContain('log-contact-attempt');
  });

  it('renders contact attempts and service requests on the case page', () => {
    const markup = renderResponderCase({
      shell,
      need: {
        caseId: 'case-0001',
        caseStatus: 'ASSIGNED',
        category: 'Support Case',
        openedLabel: 'Opened',
      },
      contactAttempts: [
        { channel: 'PHONE', outcome: 'REACHED', attemptedAtLabel: '2026-08-26T12:00:00.000Z' },
      ],
      serviceRequests: [{ category: 'FOOD', status: 'REQUESTED' }],
    });
    expect(markup).toContain('Contact attempts');
    expect(markup).toContain('PHONE · REACHED');
    expect(markup).toContain('Service requests');
    expect(markup).toContain('FOOD · REQUESTED');
    expect(auditAccessibility(markup)).toEqual([]);
  });

  it('states empty lists without inventing rows', () => {
    const markup = renderResponderCase({
      shell,
      need: {
        caseId: 'case-0002',
        caseStatus: 'OPEN',
        category: 'Support Case',
        openedLabel: 'Opened',
        claimable: true,
      },
      contactAttempts: [],
      serviceRequests: [],
    });
    expect(markup).toContain('No contact attempts recorded for this case.');
    expect(markup).toContain('No service requests on this case.');
  });
});

describe('Chat is honest about being unimplemented', () => {
  it('states unavailability rather than rendering an empty inbox', () => {
    const markup = renderChat({
      shell,
      availability: { status: 'UNAVAILABLE', reason: 'Messaging is not available yet.' },
    });
    expect(markup).toContain('Messaging is not available yet.');
    expect(markup).not.toContain('You have no conversations yet.');
  });

  it('cannot express an empty inbox without declaring messaging available', () => {
    // The union makes "no threads and no reason" unrepresentable, so the empty
    // inbox reachable below is a deliberate choice by a future caller.
    const markup = renderChat({ shell, availability: { status: 'AVAILABLE', threads: [] } });
    expect(markup).toContain('You have no conversations yet.');
  });
});

describe('Veteran-authored text is data, not markup', () => {
  it('escapes a thread preview containing markup', () => {
    const markup = renderChat({
      shell,
      availability: {
        status: 'AVAILABLE',
        threads: [
          {
            threadId: 't1',
            counterpartLabel: 'Responder',
            lastMessagePreview: '<script>alert(1)</script>',
          },
        ],
      },
    });
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});

describe('HTML command targets stay on registered /app routes', () => {
  it('posts Deploy and Cancel to the wired QRF routes', () => {
    const idle = renderVeteranHome({ shell, categories: CATEGORY_CARDS });
    expect(idle).toContain('action="/app/qrf/deploy"');

    const inFlight = renderVeteranHome({
      shell,
      categories: CATEGORY_CARDS,
      activeQrf: {
        facts: {
          requestStatus: 'CREATED',
          responderAssigned: false,
          responderNotificationDelivered: false,
          coordinationDegraded: false,
          matchingExhausted: false,
        },
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      },
    });
    expect(inFlight).toContain('action="/app/qrf/cancel"');
    expect(inFlight).not.toContain('Deploy QRF');
  });

  it('keeps enrollment role links on /app/join instead of a dead path', () => {
    const markup = renderEnrollment({
      shell: { title: 'Join the Mission', viewport: 'MOBILE', showMobileNav: false },
      contactChannelRequirement:
        'We need an email address or mobile number to send your sign-in code.',
    });
    expect(markup).toContain('href="/app/join?role=veteran"');
    expect(markup).toContain('href="/app/join?role=responder"');
    expect(markup).not.toContain('href="/app/join/veteran"');
    expect(markup).not.toContain('href="/app/join/responder"');
  });

  it('does not post On Duty to /app/responder/availability', () => {
    const dashboard = renderResponderDashboard({
      shell,
      duty: { status: 'UNAVAILABLE', reason: DUTY_UNAVAILABLE_REASON },
      activeNeeds: [],
      alerts: [],
      quickShareCategories: [],
      metrics: [],
    });
    expect(dashboard).not.toContain('action="/app/responder/availability"');
    expect(dashboard).not.toContain('Go on duty');
  });
});

describe('Consents and trusted contacts HTML', () => {
  it('lists grants without inventing permissions', () => {
    const markup = renderConsentsList({
      shell,
      grants: [
        {
          permission: 'can_view',
          scope: 'support_signal',
          purpose: 'View support signal',
          granteeType: 'TRUSTED_CONTACT',
          status: 'ACTIVE',
          grantedAtLabel: '2026-08-26T12:00:00.000Z',
        },
      ],
    });
    expect(markup).toContain('Consents');
    expect(markup).toContain('can_view');
    expect(markup).toContain('ACTIVE');
    expect(auditAccessibility(markup)).toEqual([]);
  });

  it('lists trusted contacts without invite channels', () => {
    const markup = renderTrustedContactsList({
      shell,
      contacts: [{ relationshipLabel: 'Battle buddy', status: 'INVITED' }],
    });
    expect(markup).toContain('Trusted contacts');
    expect(markup).toContain('Battle buddy');
    expect(markup).toContain('INVITED');
    expect(markup).not.toContain('mailto:');
    expect(markup).not.toContain('secret-invite');
    expect(auditAccessibility(markup)).toEqual([]);
  });

  it('links privacy pages from home when hrefs are supplied', () => {
    const markup = renderVeteranHome({
      shell,
      categories: CATEGORY_CARDS,
      consentsHref: '/app/consents',
      trustedContactsHref: '/app/trusted-contacts',
    });
    expect(markup).toContain('href="/app/consents"');
    expect(markup).toContain('href="/app/trusted-contacts"');
    expect(markup).toContain('View consents');
  });
});

describe('Notifications inbox HTML', () => {
  it('lists public fields and never destinations or bodies', () => {
    const markup = renderNotificationsInbox({
      shell,
      limit: 50,
      notifications: [
        {
          reason: 'qrf.responder_notified',
          channel: 'IN_APP',
          deliveryStatus: 'DELIVERED',
          attemptCount: 1,
          sentAtLabel: '2026-08-26T12:00:00.000Z',
          subjectType: 'ServiceRequest',
        },
      ],
    });
    expect(markup).toContain('Notifications');
    expect(markup).toContain('qrf.responder_notified');
    expect(markup).toContain('DELIVERED');
    expect(markup).toContain('IN_APP');
    expect(markup).not.toContain('mailto:');
    expect(markup).not.toContain('secret-');
    expect(auditAccessibility(markup)).toEqual([]);
  });

  it('states an empty inbox without implying messaging works', () => {
    const markup = renderNotificationsInbox({ shell, limit: 50, notifications: [] });
    expect(markup).toContain('No notifications yet.');
  });

  it('links Open notifications from home when href is supplied', () => {
    const markup = renderVeteranHome({
      shell,
      categories: CATEGORY_CARDS,
      notificationsHref: '/app/notifications',
    });
    expect(markup).toContain('href="/app/notifications"');
    expect(markup).toContain('Open notifications');
  });
});

describe('Check-In HTML copy stays honest', () => {
  const checkInShell = { title: 'Check-In', viewport: 'MOBILE', showMobileNav: true } as const;

  it('renders start and session markup without a decidable a11y failure', () => {
    const start = renderCheckInStart({
      shell: checkInShell,
      supportSignalMode: 'fixture',
    });
    const session = renderCheckInSession({
      shell: checkInShell,
      checkInId: '11111111-1111-4111-8111-111111111111',
      status: 'STARTED',
      questionnaireVersion: 'qv-001',
      questionIndex: 1,
      questionCount: 9,
      canComplete: true,
      currentQuestion: {
        questionId: '22222222-2222-4222-8222-222222222222',
        prompt: 'Do you feel safe right now?',
        required: true,
        options: [
          { answerOptionId: '33333333-3333-4333-8333-333333333333', label: 'Yes' },
          {
            answerOptionId: '44444444-4444-4444-8444-444444444444',
            label: 'No; I need immediate help',
          },
        ],
      },
    });
    expect(auditAccessibility(start)).toEqual([]);
    expect(auditAccessibility(session)).toEqual([]);
    expect(session).toContain(
      'action="/app/check-ins/11111111-1111-4111-8111-111111111111/responses"',
    );
    expect(session).toContain(
      'action="/app/check-ins/11111111-1111-4111-8111-111111111111/commands/complete"',
    );
  });

  it('states fixture mode is not a clinical score', () => {
    const completed = presentCheckInResult({
      status: 'COMPLETED',
      supportSignalMode: 'fixture',
      signalLevel: 'GREEN',
      supportCaseOpened: false,
    });
    expect(completed.detail).toContain('not a clinical score');
    expect(completed.detail).toContain('not a diagnosis');
    expect(completed.detail).toContain('did not contact emergency services');
    expect(completed.detail.toLowerCase()).not.toContain('transition');
    expect(completed.detail.toLowerCase()).not.toContain('911');
    expect(completed.detail.toLowerCase()).not.toContain('suicid');
  });

  it('mentions a Support Case only when RED opened one', () => {
    const red = presentCheckInResult({
      status: 'COMPLETED',
      supportSignalMode: 'fixture',
      signalLevel: 'RED',
      supportCaseOpened: true,
    });
    expect(red.detail).toContain('A Support Case was opened');
    expect(red.detail).toContain('did not contact emergency services');

    const incomplete = presentCheckInResult({
      status: 'INCOMPLETE',
      supportSignalMode: 'fixture',
      supportCaseOpened: false,
    });
    expect(incomplete.headline).toContain('incomplete');
    expect(incomplete.detail).toContain('No Support Signal was computed');
  });

  it('escapes a question prompt that contains markup', () => {
    const markup = renderCheckInSession({
      shell: checkInShell,
      checkInId: '11111111-1111-4111-8111-111111111111',
      status: 'IN_PROGRESS',
      questionnaireVersion: 'qv-001',
      canComplete: true,
      currentQuestion: {
        questionId: '22222222-2222-4222-8222-222222222222',
        prompt: '<script>alert(1)</script>',
        required: true,
        options: [{ answerOptionId: '33333333-3333-4333-8333-333333333333', label: 'Yes' }],
      },
    });
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('&lt;script&gt;');
  });
});
