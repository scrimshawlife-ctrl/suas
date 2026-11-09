import { describe, expect, it } from 'vitest';
import type { CatalogResource } from './api';
import {
  categoryFromParam,
  contactActions,
  describeFreshness,
  mailHref,
  phoneHref,
  REQUEST_BAND,
} from './resources-model';

function resource(overrides: Partial<CatalogResource>): CatalogResource {
  return {
    resource_id: 'r1',
    service_name: 'Pantry',
    category: 'FOOD',
    counties: ['SANTA_CLARA'],
    hours: null,
    cost: null,
    contact_method: null,
    contact_method_kind: null,
    contacts: [],
    area: null,
    verified_at: null,
    freshness: 'FRESH',
    stale_warning: false,
    ...overrides,
  };
}

describe('categoryFromParam', () => {
  it('maps the lowercase route param to the API enum', () => {
    expect(categoryFromParam('food')).toBe('FOOD');
    expect(categoryFromParam('transportation')).toBe('TRANSPORTATION');
    expect(categoryFromParam('shelter')).toBe('SHELTER');
    expect(categoryFromParam('peer_support')).toBe('PEER_SUPPORT');
  });

  it('treats anything else as not available yet', () => {
    for (const bad of ['FOOD', 'legal', 'peer-support', 'toString', '__proto__', '', undefined]) {
      expect(categoryFromParam(bad)).toBeNull();
    }
  });

  it('has a request band for every category', () => {
    for (const category of ['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'] as const) {
      expect(REQUEST_BAND[category].heading).not.toBe('');
    }
  });
});

/** The single-contact shape every older listing has: no `contacts` list. */
const single = (
  method: string | null,
  kind: CatalogResource['contact_method_kind'],
  name = 'Pantry',
) => resource({ service_name: name, contact_method: method, contact_method_kind: kind });

describe('contactActions', () => {
  it('maps each kind: PHONE to tel, URL to website, EMAIL to mailto, FREEFORM to text', () => {
    expect(
      contactActions(
        resource({
          contacts: [
            { kind: 'PHONE', value: '(408) 555-0142' },
            { kind: 'URL', value: 'https://example.org' },
            { kind: 'EMAIL', value: 'locker@example.org' },
          ],
        }),
      ),
    ).toEqual([
      { kind: 'phone', label: 'Call Pantry at (408) 555-0142', href: 'tel:4085550142' },
      { kind: 'url', label: 'Visit website', href: 'https://example.org/' },
      { kind: 'email', label: 'Email locker@example.org', href: 'mailto:locker@example.org' },
    ]);
    expect(
      contactActions(resource({ contacts: [{ kind: 'FREEFORM', value: 'Walk in' }] })),
    ).toEqual([{ kind: 'text', text: 'Walk in' }]);
  });

  it('keeps the listed order and ignores the single fields when a list exists', () => {
    const actions = contactActions(
      resource({
        contact_method: '408-555-0100',
        contact_method_kind: 'PHONE',
        contacts: [
          { kind: 'URL', value: 'https://example.org' },
          { kind: 'PHONE', value: '408-555-0100' },
        ],
      }),
    );
    expect(actions.map((action) => action.kind)).toEqual(['url', 'phone']);
  });

  it('falls back to the single contact when the list is empty', () => {
    expect(contactActions(single('(408) 555-0142', 'PHONE'))).toEqual([
      { kind: 'phone', label: 'Call Pantry at (408) 555-0142', href: 'tel:4085550142' },
    ]);
    expect(contactActions(single('Ask at the desk', null))).toEqual([
      { kind: 'text', text: 'Ask at the desk' },
    ]);
  });

  it('is empty when no contact is recorded', () => {
    expect(contactActions(resource({}))).toEqual([]);
    expect(contactActions(single('  ', 'PHONE'))).toEqual([]);
  });

  it('only links http and https, and shows other web text as written', () => {
    expect(
      contactActions(resource({ contacts: [{ kind: 'URL', value: 'javascript:alert(1)' }] })),
    ).toEqual([{ kind: 'text', text: 'javascript:alert(1)' }]);
  });

  it('never makes 911, 988 or 838255 an action, in the list or the single fields', () => {
    for (const number of ['911', '988', '838255']) {
      expect(phoneHref(number)).toBeNull();
      const expected = [{ kind: 'text', text: number }];
      expect(contactActions(resource({ contacts: [{ kind: 'PHONE', value: number }] }))).toEqual(
        expected,
      );
      expect(contactActions(single(number, 'PHONE', number))).toEqual(expected);
    }
  });
});

describe('describeFreshness', () => {
  it('fresh is the ok chip with the verified date and no out-of-date line', () => {
    expect(
      describeFreshness(resource({ freshness: 'FRESH', verified_at: '2026-10-28T19:00:00Z' })),
    ).toEqual({ label: 'Verified Oct 28', chip: 'ok', outOfDate: false });
  });

  it('uses the Pacific calendar day for the verified date', () => {
    expect(describeFreshness(resource({ verified_at: '2026-10-29T03:30:00Z' })).label).toBe(
      'Verified Oct 28',
    );
  });

  it('stale uses the stale chip, the date and the out-of-date line', () => {
    expect(
      describeFreshness(
        resource({ freshness: 'STALE', stale_warning: true, verified_at: '2026-07-02T19:00:00Z' }),
      ),
    ).toEqual({ label: 'Verified Jul 2', chip: 'stale', outOfDate: true });
    expect(describeFreshness(resource({ freshness: 'STALE', stale_warning: false }))).toMatchObject(
      { chip: 'stale', outOfDate: true },
    );
  });

  it('follows stale_warning for aging listings and keeps the band words with no date', () => {
    expect(
      describeFreshness(resource({ freshness: 'AGING', stale_warning: true, verified_at: null })),
    ).toMatchObject({ label: 'Checked a while ago', chip: 'stale', outOfDate: true });
    expect(
      describeFreshness(resource({ freshness: 'UNVERIFIED', stale_warning: true })),
    ).toMatchObject({ label: 'Not checked yet', outOfDate: true });
  });
});

describe('phoneHref', () => {
  it('builds a tel: link only for one whole phone number', () => {
    expect(phoneHref('(408) 555-0142')).toBe('tel:4085550142');
    expect(phoneHref('+1-555-555-0101')).toBe('tel:+15555550101');
    expect(phoneHref('  408.555.0142 ')).toBe('tel:4085550142');
  });

  it('shows text for extensions, two numbers, letters, a mid-string plus and bad lengths', () => {
    for (const text of [
      '408-555-0142 ext. 5',
      '408-555-0142 x5',
      '408-555-0142 / 408-555-0178',
      '(408) 555-0142 (408) 555-0178',
      '408-555-0142 or ask for Dee',
      '408+555-0142',
      '1-800-FLOWERS',
      '555-01',
      '+1234567890123456',
      'tel:4085550142',
    ]) {
      expect(phoneHref(text), text).toBeNull();
    }
  });
});

describe('mailHref', () => {
  it('builds a mailto: link only for one plain address, encoded', () => {
    expect(mailHref('locker@example.org')).toBe('mailto:locker@example.org');
    expect(mailHref("o'brien+help@example.org")).toBe("mailto:o'brien%2Bhelp@example.org");
  });

  it('shows text when the string could add a subject, a recipient or spaces', () => {
    for (const text of [
      'a@example.org?subject=x',
      'a@example.org&cc=b@example.org',
      'a@example.org,b@example.org',
      'a@example.org b@example.org',
      'Dee <a@example.org>',
      'a@example',
      'no address',
    ]) {
      expect(mailHref(text), text).toBeNull();
    }
  });
});
