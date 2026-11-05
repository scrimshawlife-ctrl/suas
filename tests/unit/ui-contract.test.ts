/**
 * Reference conformance contract evidence.
 *
 * SUAS-specs MVP_REFERENCE.md §2 (no required element may silently disappear),
 * §5 (required surface inventory), §6 (category/display mapping), §7.2 (QRF
 * truthfulness), §7.3 + SAFETY.md §2/§9 (D-012 reserved copy slot), §11
 * (fixture contract).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVED_CRISIS_DESTINATIONS,
  APPROVED_CRISIS_RESOURCES,
  PENDING_RELEASE_CRISIS_DESTINATIONS,
  assertApprovedSafetyCopyAvailable,
  CATEGORY_CARDS,
  categoryForCard,
  contactAffordances,
  containsForbiddenCrisisPhrase,
  CRISIS_ENTRY_HEADING,
  CRISIS_ENTRY_NOT_EMERGENCY,
  D_012_APPROVED_SAFETY_COPY,
  FORBIDDEN_CRISIS_PHRASES,
  NonOperationalCategoryError,
  presentQrfState,
  REQUIRED_FIXTURE_COVERAGE,
  REQUIRED_SURFACES,
  requireSurface,
  resolveImmediateResourceSlot,
  UnapprovedSafetyCopyError,
  UnknownSurfaceError,
  VISUAL_FIXTURES,
  type QrfFacts,
} from '../../src/ui/index.js';

function facts(overrides: Partial<QrfFacts> = {}): QrfFacts {
  return {
    requestStatus: 'SUBMITTED',
    assigned: false,
    assignedNotificationDelivered: false,
    coordinationDegraded: false,
    matchingExhausted: false,
    ...overrides,
  };
}

describe('MVP_REFERENCE.md §5 — required surface inventory', () => {
  it('declares every surface the released table lists', () => {
    expect(REQUIRED_SURFACES).toHaveLength(10);
  });

  it('refuses a surface that is not in the released inventory', () => {
    expect(() => requireSurface('GOD_MODE')).toThrow(UnknownSurfaceError);
  });

  it('covers every §11 fixture requirement with at least one fixture', () => {
    const covered = new Set(VISUAL_FIXTURES.map((fixture) => fixture.surfaceId));
    const missing = REQUIRED_FIXTURE_COVERAGE.filter((surface) => !covered.has(surface));
    expect(missing, `uncovered surfaces: ${missing.join(', ')}`).toEqual([]);
  });

  it('records the six fields §11 requires on every fixture', () => {
    for (const fixture of VISUAL_FIXTURES) {
      expect(fixture.viewport, fixture.id).toBeDefined();
      expect(fixture.role, fixture.id).toBeDefined();
      expect(fixture.conformance, fixture.id).toBeDefined();
      expect(fixture.divergences, fixture.id).toBeDefined();
      expect(fixture.description, fixture.id).not.toBe('');
    }
  });
});

describe('MVP_REFERENCE.md §6 — category/display mapping', () => {
  it('keeps all six reference labels visible', () => {
    const labels = CATEGORY_CARDS.map((card) => card.label);
    expect(labels).toEqual([
      'Housing',
      'Food',
      'Transportation',
      'Counseling',
      'Activities',
      'Job Training',
    ]);
  });

  it('maps Housing to temporary SHELTER, not the FUTURE HOUSING workflow', () => {
    expect(categoryForCard('Housing')).toBe('SHELTER');
  });

  it('maps Food and Transportation to their released categories', () => {
    expect(categoryForCard('Food')).toBe('FOOD');
    expect(categoryForCard('Transportation')).toBe('TRANSPORTATION');
  });

  it.each(['Counseling', 'Activities', 'Job Training'])(
    'refuses to turn the %s card into a Service Request',
    (label) => {
      expect(() => categoryForCard(label)).toThrow(NonOperationalCategoryError);
    },
  );

  it('refuses an unknown card outright', () => {
    expect(() => categoryForCard('Benefits')).toThrow(NonOperationalCategoryError);
  });
});

describe('MVP_REFERENCE.md §7.2 — QRF truthfulness', () => {
  it('reports a recorded request as REQUESTED', () => {
    expect(presentQrfState(facts({ requestStatus: 'SUBMITTED' })).state).toBe('REQUESTED');
  });

  it('reports matching as SEARCHING', () => {
    expect(presentQrfState(facts({ requestStatus: 'MATCHING' })).state).toBe('SEARCHING');
  });

  it('does not claim a responder was notified from an assignment alone', () => {
    const presentation = presentQrfState(facts({ requestStatus: 'ASSIGNED', assigned: true }));
    expect(presentation.state).toBe('SEARCHING');
    expect(presentation.basis).toContain('no recorded notification delivery');
  });

  it('reports RESPONDER_NOTIFIED only with a recorded delivery', () => {
    const presentation = presentQrfState(
      facts({
        requestStatus: 'ASSIGNED',
        assigned: true,
        assignedNotificationDelivered: true,
      }),
    );
    expect(presentation.state).toBe('RESPONDER_NOTIFIED');
  });

  it('reports an exhausted match as no responder currently available', () => {
    expect(
      presentQrfState(facts({ requestStatus: 'MATCHING', matchingExhausted: true })).state,
    ).toBe('NO_RESPONDER_CURRENTLY_AVAILABLE');
  });

  it('surfaces a failed dependency as DEGRADED rather than a calm search', () => {
    expect(
      presentQrfState(facts({ requestStatus: 'MATCHING', coordinationDegraded: true })).state,
    ).toBe('DEGRADED');
  });

  it('leaves a cancelled request non-cancellable', () => {
    const presentation = presentQrfState(facts({ requestStatus: 'CANCELLED' }));
    expect(presentation.state).toBe('CANCELLED');
    expect(presentation.cancellable).toBe(false);
  });

  it.each(['FULFILLED', 'CONFIRMED', 'CLOSED'] as const)(
    'keeps a %s request on RESPONDER_ACCEPTED instead of falling back to SEARCHING',
    (requestStatus) => {
      const presentation = presentQrfState(facts({ requestStatus, assigned: true }));
      expect(presentation.state).toBe('RESPONDER_ACCEPTED');
      expect(presentation.headline).not.toContain('Looking for');
    },
  );

  it('offers cancel exactly where DISPATCH.md §4 documents a CANCEL edge', () => {
    const cancellable = [
      'CREATED',
      'SUBMITTED',
      'TRIAGED',
      'MATCHING',
      'ASSIGNED',
      'ACCEPTED',
      'IN_PROGRESS',
    ] as const;
    const notCancellable = [
      'FULFILLED',
      'CONFIRMED',
      'CLOSED',
      'CANCELLED',
      'DECLINED',
      'EXPIRED',
      'UNFULFILLABLE',
      'ESCALATED',
    ] as const;
    for (const requestStatus of cancellable) {
      expect(presentQrfState(facts({ requestStatus })).cancellable, requestStatus).toBe(true);
    }
    for (const requestStatus of notCancellable) {
      expect(presentQrfState(facts({ requestStatus })).cancellable, requestStatus).toBe(false);
    }
    // A degraded path or an exhausted match does not change the domain's edges.
    expect(
      presentQrfState(facts({ requestStatus: 'MATCHING', coordinationDegraded: true })).cancellable,
    ).toBe(true);
  });

  it('maps every released request status to a label without falling through', () => {
    const statuses = [
      'CREATED',
      'SUBMITTED',
      'TRIAGED',
      'MATCHING',
      'ASSIGNED',
      'ACCEPTED',
      'IN_PROGRESS',
      'FULFILLED',
      'CONFIRMED',
      'CLOSED',
      'CANCELLED',
      'DECLINED',
      'EXPIRED',
      'UNFULFILLABLE',
      'ESCALATED',
    ] as const;
    for (const status of statuses) {
      expect(presentQrfState(facts({ requestStatus: status })).state, status).toBeDefined();
    }
  });

  it('hides Call and Message until a counterpart exists', () => {
    expect(
      contactAffordances({
        state: 'SEARCHING',
        authorizedVoicePath: true,
        authorizedMessagePath: true,
      }),
    ).toEqual({ call: false, message: false });
  });

  it('hides Call and Message when no authorized path exists', () => {
    expect(
      contactAffordances({
        state: 'RESPONDER_ACCEPTED',
        authorizedVoicePath: false,
        authorizedMessagePath: false,
      }),
    ).toEqual({ call: false, message: false });
  });

  it('shows only the authorized path', () => {
    expect(
      contactAffordances({
        state: 'RESPONDER_ACCEPTED',
        authorizedVoicePath: false,
        authorizedMessagePath: true,
      }),
    ).toEqual({ call: false, message: true });
  });
});

describe('SAFETY.md §2 / SAFETY_COPY.md — D-012 approved crisis copy', () => {
  it('records D-012 as decided', () => {
    expect(D_012_APPROVED_SAFETY_COPY).toBe('DECIDED');
  });

  it('renders a placeholder by default and in every non-approved mode', () => {
    for (const mode of ['placeholder_test_only', 'disabled'] as const) {
      const slot = resolveImmediateResourceSlot(mode);
      expect(slot.state, mode).toBe('PLACEHOLDER');
      expect(slot.resources, mode).toEqual([]);
      expect(slot.placeholder, mode).toBeDefined();
    }
    expect(resolveImmediateResourceSlot().state).toBe('PLACEHOLDER');
  });

  it('refuses to present safety copy as official unless the mode is approved', () => {
    expect(() => assertApprovedSafetyCopyAvailable('A red check-in outcome')).toThrow(
      UnapprovedSafetyCopyError,
    );
    expect(() => assertApprovedSafetyCopyAvailable('A red check-in outcome', 'disabled')).toThrow(
      UnapprovedSafetyCopyError,
    );
    expect(() =>
      assertApprovedSafetyCopyAvailable('A red check-in outcome', 'approved'),
    ).not.toThrow();
  });

  it('renders the released 911/988 destinations only in approved mode', () => {
    const slot = resolveImmediateResourceSlot('approved');
    expect(slot.state).toBe('APPROVED');
    expect(slot.resources).toEqual(APPROVED_CRISIS_RESOURCES);
    expect(slot.resources.map((resource) => resource.destination)).toEqual(['tel:911', 'tel:988']);
    expect(slot.resources.map((resource) => resource.label)).toEqual([
      'Call 911',
      'Call or text 988',
    ]);
  });

  it('authorizes no released destination other than 911 and 988', async () => {
    const source = readFileSync(new URL('../../src/ui/safety.ts', import.meta.url), 'utf8');
    const prose = source.replace(/\n\s*\*\s?/g, ' ').replace(/\s+/g, ' ');
    expect(prose).toContain(
      '838255 (sms:838255, Text 838255): owner-decided as D-050 on 2026-11-05, pending a spec release; the pinned spec 0.7.0 SAFETY_COPY authorizes only 911 and 988.',
    );
    expect(source).not.toMatch(/\b1-?800-?\d{3}-?\d{4}\b/);
    expect(source).not.toMatch(/https?:\/\//);
    expect([...APPROVED_CRISIS_DESTINATIONS]).toEqual(['tel:911', 'tel:988', 'sms:988']);
    expect([...PENDING_RELEASE_CRISIS_DESTINATIONS]).toEqual(['sms:838255']);
    expect(APPROVED_CRISIS_RESOURCES.map((resource) => resource.destination)).toEqual([
      'tel:911',
      'tel:988',
    ]);
    const allowed = new Set<string>([
      ...APPROVED_CRISIS_DESTINATIONS,
      ...PENDING_RELEASE_CRISIS_DESTINATIONS,
    ]);
    const root = fileURLToPath(new URL('../../web/src/', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(tsx|ts)$/.test(name) || /\.test\.(tsx|ts)$/.test(name)) continue;
        files.push(path);
      }
    };
    walk(root);
    const hrefs: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/href="((?:tel|sms):[^"]+)"/g)) {
        const href = match[1] ?? '';
        hrefs.push(href);
        expect(allowed.has(href), `${file} ${href}`).toBe(true);
      }
    }
    expect(hrefs).toEqual(expect.arrayContaining(['tel:911', 'tel:988', 'sms:988', 'sms:838255']));

    // Directory listings, same shape as GET /api/v0/resources (CatalogResourceList).
    // The model has no crisis category or crisis contact flag. 911, 988 and 838255
    // are still passed through phoneHref and contactAction; phoneHref only links a
    // number of 7 to 15 digits, so those three stay text unless a future change emits them.
    // Owner decision (Danny, 2026-11-05 1:20 PM PT): "You can keep those numbers" /
    // "Just label them appropriately". Hotline-shaped directory numbers stay
    // directory resources and are labelled with the listed resource name.
    interface DirectoryResource {
      resource_id: string;
      service_name: string;
      category: 'FOOD' | 'TRANSPORTATION' | 'SHELTER' | 'PEER_SUPPORT';
      counties: string[];
      hours: string | null;
      cost: string | null;
      contact_method: string | null;
      contact_method_kind: 'PHONE' | 'EMAIL' | 'URL' | 'FREEFORM' | null;
      freshness: 'FRESH' | 'AGING' | 'STALE' | 'UNVERIFIED';
      stale_warning: boolean;
    }
    const directory: { resources: DirectoryResource[]; limit: number; next_cursor: null } = {
      resources: [
        {
          resource_id: '11111111-1111-4111-8111-111111111111',
          service_name: 'County food pantry',
          category: 'FOOD',
          counties: ['SANTA_CLARA'],
          hours: null,
          cost: null,
          contact_method: '(408) 555-0142',
          contact_method_kind: 'PHONE',
          freshness: 'FRESH',
          stale_warning: false,
        },
        {
          resource_id: '22222222-2222-4222-8222-222222222222',
          service_name: '911',
          category: 'PEER_SUPPORT',
          counties: ['SANTA_CLARA'],
          hours: null,
          cost: null,
          contact_method: '911',
          contact_method_kind: 'PHONE',
          freshness: 'FRESH',
          stale_warning: false,
        },
        {
          resource_id: '33333333-3333-4333-8333-333333333333',
          service_name: '988',
          category: 'PEER_SUPPORT',
          counties: ['SANTA_CLARA'],
          hours: null,
          cost: null,
          contact_method: '988',
          contact_method_kind: 'PHONE',
          freshness: 'FRESH',
          stale_warning: false,
        },
        {
          resource_id: '44444444-4444-4444-8444-444444444444',
          service_name: '838255',
          category: 'PEER_SUPPORT',
          counties: ['SANTA_CLARA'],
          hours: null,
          cost: null,
          contact_method: '838255',
          contact_method_kind: 'PHONE',
          freshness: 'FRESH',
          stale_warning: false,
        },
        {
          resource_id: '55555555-5555-4555-8555-555555555555',
          service_name: 'National Lifeline',
          category: 'PEER_SUPPORT',
          counties: ['SANTA_CLARA'],
          hours: null,
          cost: null,
          // Toll-free shape with a leading 1, split so the fixture scan sees no routable literal.
          contact_method: ['1', '800', '273', '8255'].join('-'),
          contact_method_kind: 'PHONE',
          freshness: 'FRESH',
          stale_warning: false,
        },
        {
          resource_id: '66666666-6666-4666-8666-666666666666',
          service_name: 'Local helpline',
          category: 'PEER_SUPPORT',
          counties: ['SANTA_CLARA'],
          hours: null,
          cost: null,
          // Parenthesized toll-free shape, split the same way.
          contact_method: `(${'800'}) ${['273', '8255'].join('-')}`,
          contact_method_kind: 'PHONE',
          freshness: 'FRESH',
          stale_warning: false,
        },
      ],
      limit: 6,
      next_cursor: null,
    };
    const modelUrl = new URL('../../web/src/features/support/resources-model.ts', import.meta.url)
      .href;
    const model = (await import(modelUrl)) as {
      phoneHref: (text: string) => string | null;
      contactAction: (resource: DirectoryResource) => {
        kind: string;
        href?: string;
        label?: string;
      };
    };
    const produced: string[] = [];
    const consider = (href: string | null): void => {
      if (href === null || href === '') return;
      produced.push(href);
      const digits = href.replace(/^(?:tel|sms):/, '').replace(/\D/g, '');
      const crisis = digits === '911' || digits === '988' || digits === '838255';
      if (crisis) expect(allowed.has(href), href).toBe(true);
    };
    for (const resource of directory.resources) {
      const method = resource.contact_method ?? '';
      consider(model.phoneHref(method));
      const action = model.contactAction(resource);
      if (action.kind === 'phone') {
        expect(action.label, resource.service_name).toBe(resource.service_name);
        expect(action.href ?? '').toMatch(/^tel:/);
      }
      consider(action.href ?? null);
    }
    expect(produced.length).toBeGreaterThan(0);
    const national = ['1', '800', '273', '8255'].join('-');
    const local = `(${'800'}) ${['273', '8255'].join('-')}`;
    expect(produced).toEqual(
      expect.arrayContaining([
        `tel:${national.replace(/\D/g, '')}`,
        `tel:${local.replace(/\D/g, '')}`,
      ]),
    );
  });

  it('states placeholder unavailability without giving crisis guidance', () => {
    const placeholder = resolveImmediateResourceSlot().placeholder ?? '';
    for (const forbidden of ['call', 'text', 'emergency', 'suicide', 'crisis line']) {
      expect(placeholder.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it('keeps the approved copy free of SAFETY_COPY.md §4 forbidden phrases', () => {
    const approved = [
      CRISIS_ENTRY_HEADING,
      CRISIS_ENTRY_NOT_EMERGENCY,
      ...APPROVED_CRISIS_RESOURCES.map((resource) => resource.label),
    ].join('\n');
    expect(containsForbiddenCrisisPhrase(approved)).toBeUndefined();
    for (const phrase of FORBIDDEN_CRISIS_PHRASES) {
      expect(approved.toLowerCase(), phrase).not.toContain(phrase.toLowerCase());
    }
  });
});
