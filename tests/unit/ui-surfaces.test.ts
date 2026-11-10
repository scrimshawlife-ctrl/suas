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
  MissingRequiredElementError,
  presentCheckInResult,
  renderChat,
  renderConsentsList,
  renderTrustedContactsList,
  renderCheckInSession,
  renderCheckInStart,
  renderEnrollment,
  renderImmediateResources,
  renderNotificationPreferences,
  renderNotificationsInbox,
  renderResourceList,
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
      expect((error as MissingRequiredElementError).missing).toEqual(['I NEED SUPPORT']);
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
    expect(markup).not.toMatch(/\b838255\b/);
  });

  it('shows iOS-reference chrome without adding a Check-In surface to the §11 fixture', () => {
    expect(markup).toContain('class="brand-name">SUAS');
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

  it('renders the D-050 Veterans Crisis Line text action (SAFETY_COPY.md §0, §1.1)', () => {
    for (const page of [approvedHome, approvedSlot]) {
      expect(page).toContain('href="sms:838255"');
      expect(page).toContain('aria-label="Veterans Crisis Line: Text 838255"');
      expect(page).toContain('>Text 838255</a>');
    }
  });

  it('renders the SAFETY_COPY.md §2.1 compact banner and §2.3 footer, verbatim', () => {
    expect(approvedSlot).toContain(
      'Immediate danger? Call 911. For suicide or emotional crisis support, call or text 988. Veterans Crisis Line: Text 838255. SUAS provides practical support coordination and is not an emergency-response service.',
    );
    expect(approvedSlot).toContain(
      'SUAS coordinates community support. It does not provide emergency medical care or emergency dispatch. For immediate danger, call 911. For suicide or emotional crisis support, call or text 988. Veterans Crisis Line: Text 838255.',
    );
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
        assigned: false,
        assignedNotificationDelivered: false,
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
            counterpartLabel: 'Peer',
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
          assigned: false,
          assignedNotificationDelivered: false,
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

  it('keeps role-specific sign-in focused and leaves role choice on the landing page', () => {
    const markup = renderEnrollment({
      shell: { title: 'Join the Mission', viewport: 'MOBILE', showMobileNav: false },
      contactChannelRequirement:
        'We need an email address or mobile number to send your sign-in code.',
      selectedRole: 'veteran',
    });
    expect(markup).toContain('Sign in to continue');
    expect(markup).toContain('Veteran');
    expect(markup).not.toContain('demo@example.invalid');
    expect(markup).not.toContain('href="/app/join?role=veteran"');
  });

  it('shows the synthetic demo sign-in when the environment offers it', () => {
    const markup = renderEnrollment({
      shell: { title: 'Join the Mission', viewport: 'MOBILE', showMobileNav: false },
      contactChannelRequirement: 'Use the enrolled email.',
      authEnabled: true,
      selectedRole: 'veteran',
      demoSignIn: { email: 'demo@example.invalid', code: '123456' },
    });
    expect(markup).toContain('demo@example.invalid');
    expect(markup).toContain('123456');
    expect(markup).toContain('value="demo@example.invalid"');
    expect(markup).toContain('No email is sent for this account.');
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

describe('Channel preferences HTML', () => {
  it('states that preferences do not grant consent', () => {
    const markup = renderNotificationPreferences({
      shell,
      preferences: [
        { channel: 'EMAIL', enabled: true },
        { channel: 'SMS', enabled: false },
        { channel: 'IN_APP', enabled: true },
      ],
    });
    expect(markup).toContain('Channel preferences');
    expect(markup).toContain('do not grant consent');
    expect(markup).toContain('Disable EMAIL');
    expect(markup).toContain('Enable SMS');
    expect(markup).toContain('action="/app/notifications/preferences"');
    expect(auditAccessibility(markup)).toEqual([]);
  });

  it('links preferences from the notifications inbox when supplied', () => {
    const markup = renderNotificationsInbox({
      shell,
      limit: 50,
      notifications: [],
      preferencesHref: '/app/notifications/preferences',
    });
    expect(markup).toContain('href="/app/notifications/preferences"');
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
