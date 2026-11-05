import { describe, expect, it } from 'vitest';
import type { CatalogResource } from './api';
import {
  categoryFromParam,
  contactAction,
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

describe('contactAction', () => {
  it('phone: Call with a tel: link', () => {
    expect(
      contactAction(resource({ contact_method: '(408) 555-0142', contact_method_kind: 'PHONE' })),
    ).toEqual({
      kind: 'phone',
      label: 'Pantry',
      href: 'tel:4085550142',
    });
    expect(
      contactAction(resource({ contact_method: '+1-555-555-0101', contact_method_kind: 'PHONE' })),
    ).toMatchObject({
      href: 'tel:+15555550101',
    });
  });

  it('email: Email with a mailto: link', () => {
    expect(
      contactAction(
        resource({ contact_method: 'locker@example.org', contact_method_kind: 'EMAIL' }),
      ),
    ).toEqual({
      kind: 'email',
      label: 'Email locker@example.org',
      href: 'mailto:locker@example.org',
    });
  });

  it('url: Visit website, only for http and https', () => {
    expect(
      contactAction(
        resource({ contact_method: 'https://example.org', contact_method_kind: 'URL' }),
      ),
    ).toMatchObject({
      kind: 'url',
      label: 'Visit website',
      href: 'https://example.org/',
    });
    expect(
      contactAction(
        resource({ contact_method: 'javascript:alert(1)', contact_method_kind: 'URL' }),
      ),
    ).toEqual({
      kind: 'text',
      text: 'javascript:alert(1)',
    });
  });

  it('free text is shown as written, and no method is stated plainly', () => {
    expect(
      contactAction(resource({ contact_method: 'Walk in', contact_method_kind: 'FREEFORM' })),
    ).toEqual({
      kind: 'text',
      text: 'Walk in',
    });
    expect(
      contactAction(resource({ contact_method: 'Ask at the desk', contact_method_kind: null })),
    ).toEqual({
      kind: 'text',
      text: 'Ask at the desk',
    });
    expect(contactAction(resource({}))).toEqual({ kind: 'none' });
    expect(contactAction(resource({ contact_method: '  ', contact_method_kind: 'PHONE' }))).toEqual(
      { kind: 'none' },
    );
  });
});

describe('describeFreshness', () => {
  it('fresh is the ok chip with no out-of-date line', () => {
    expect(describeFreshness(resource({ freshness: 'FRESH' }))).toEqual({
      label: 'Checked recently',
      chip: 'ok',
      outOfDate: false,
    });
  });

  it('stale uses the stale chip and the out-of-date line', () => {
    expect(describeFreshness(resource({ freshness: 'STALE', stale_warning: true }))).toMatchObject({
      chip: 'stale',
      outOfDate: true,
    });
    expect(describeFreshness(resource({ freshness: 'STALE', stale_warning: false }))).toMatchObject(
      { outOfDate: true },
    );
  });

  it('follows stale_warning for aging and unverified listings', () => {
    expect(describeFreshness(resource({ freshness: 'AGING', stale_warning: true }))).toMatchObject({
      label: 'Checked a while ago',
      outOfDate: true,
    });
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
