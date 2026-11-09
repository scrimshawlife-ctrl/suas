import type { NeedCategory } from '../../components/needs';
import type { CatalogResource } from './api';

/** Route param (lowercase) to the API category enum. Anything else is not available yet. */
const CATEGORY_BY_PARAM: Readonly<Record<string, NeedCategory>> = {
  food: 'FOOD',
  transportation: 'TRANSPORTATION',
  shelter: 'SHELTER',
  peer_support: 'PEER_SUPPORT',
};

export function categoryFromParam(param: string | undefined): NeedCategory | null {
  if (param === undefined) return null;
  return Object.hasOwn(CATEGORY_BY_PARAM, param) ? CATEGORY_BY_PARAM[param]! : null;
}

/** The "Request essentials" band, one version per category. Food is the board's wording. */
export const REQUEST_BAND: Readonly<
  Record<NeedCategory, { heading: string; body: string; button: string }>
> = {
  FOOD: {
    heading: 'Need food or essential supplies?',
    body: 'Tell us what is needed and where support is required. SUAS will search available participating resources.',
    button: 'Request essentials',
  },
  TRANSPORTATION: {
    heading: 'Need a ride?',
    body: 'Tell us where you need to go and when. SUAS will search available participating resources.',
    button: 'Request essentials',
  },
  SHELTER: {
    heading: 'Need a place to stay?',
    body: 'Tell us what housing help is needed and where. SUAS will search available participating resources.',
    button: 'Request essentials',
  },
  PEER_SUPPORT: {
    heading: 'Want to talk with another veteran?',
    body: 'Tell us what kind of support would help. SUAS will search available participating resources.',
    button: 'Request peer support',
  },
};

export const COUNTY_NAMES: Readonly<Record<string, string>> = {
  SANTA_CLARA: 'Santa Clara',
  SAN_MATEO: 'San Mateo',
  ALAMEDA: 'Alameda',
  SANTA_CRUZ: 'Santa Cruz',
  SAN_BENITO: 'San Benito',
  MERCED: 'Merced',
  STANISLAUS: 'Stanislaus',
};

export function countyName(county: string): string {
  return COUNTY_NAMES[county] ?? county;
}

export interface Freshness {
  /** "Verified Oct 28" from the publish date; plain band words only when there is none. */
  label: string;
  chip: 'ok' | 'stale';
  /** Show "This listing may be out of date." */
  outOfDate: boolean;
}

/** Listings serve California counties, so the date is the Pacific calendar day. */
const VERIFIED_DATE = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'America/Los_Angeles',
});

function verifiedLabel(verifiedAt: string | null): string | null {
  if (verifiedAt === null) return null;
  const date = new Date(verifiedAt);
  return Number.isNaN(date.getTime()) ? null : `Verified ${VERIFIED_DATE.format(date)}`;
}

export function describeFreshness(resource: CatalogResource): Freshness {
  const outOfDate = resource.stale_warning || resource.freshness === 'STALE';
  const verified = verifiedLabel(resource.verified_at);
  switch (resource.freshness) {
    case 'FRESH':
      return { label: verified ?? 'Checked recently', chip: 'ok', outOfDate };
    case 'AGING':
      return { label: verified ?? 'Checked a while ago', chip: 'stale', outOfDate };
    case 'STALE':
      return { label: verified ?? 'Not checked recently', chip: 'stale', outOfDate };
    default:
      return { label: verified ?? 'Not checked yet', chip: 'stale', outOfDate };
  }
}

export type ContactAction =
  | { kind: 'phone'; label: string; href: string }
  | { kind: 'email'; label: string; href: string }
  | { kind: 'url'; label: string; href: string }
  /** Stored as free text: shown as written, not a link. */
  | { kind: 'text'; text: string };

/**
 * A `tel:` target only when the whole string is one phone number: digits, spaces and the
 * usual punctuation, an optional leading "+", 7 to 15 digits. Extensions, two numbers,
 * letters or a "+" in the middle fail, and the text is shown as written instead.
 */
export function phoneHref(text: string): string | null {
  const value = text.trim();
  if (!/^\+?[\d\s().-]{7,20}$/.test(value)) return null;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return `tel:${value.startsWith('+') ? '+' : ''}${digits}`;
}

/**
 * A `mailto:` target only for one plain address: no spaces, "?", "&", "," or other
 * characters that could add a subject, a second recipient or a header. Each part is encoded.
 */
export function mailHref(text: string): string | null {
  const value = text.trim();
  const match = /^([A-Za-z0-9._+'-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/.exec(value);
  if (!match) return null;
  return `mailto:${encodeURIComponent(match[1]!)}@${encodeURIComponent(match[2]!)}`;
}

type ListedContact = CatalogResource['contacts'][number];

function actionFor(
  resource: CatalogResource,
  kind: ListedContact['kind'] | null,
  value: string,
): ContactAction {
  switch (kind) {
    case 'PHONE': {
      const href = phoneHref(value);
      // Directory phones, including hotline-shaped numbers, are resources.
      // Label with the listed name, not a crisis-line label.
      // Owner decision (owner (scrimshawlife-ctrl), 2026-11-05 1:20 PM PT): "You can keep those numbers" /
      // "Just label them appropriately".
      return href === null
        ? { kind: 'text', text: value }
        : {
            kind: 'phone',
            label: `${href.startsWith('sms:') ? 'Text' : 'Call'} ${resource.service_name} at ${value}`,
            href,
          };
    }
    case 'EMAIL': {
      const href = mailHref(value);
      return href === null
        ? { kind: 'text', text: value }
        : { kind: 'email', label: `Email ${value}`, href };
    }
    case 'URL': {
      try {
        const url = new URL(value);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          return { kind: 'url', label: 'Visit website', href: url.href };
        }
      } catch {
        // Not a web address: show it as written.
      }
      return { kind: 'text', text: value };
    }
    default:
      return { kind: 'text', text: value };
  }
}

/**
 * One action per listed contact, in order. An older listing with only the single contact
 * fields yields that one. Empty when no contact is recorded.
 */
export function contactActions(resource: CatalogResource): ContactAction[] {
  const listed: { kind: ListedContact['kind'] | null; value: string }[] =
    resource.contacts.length > 0
      ? resource.contacts
      : [{ kind: resource.contact_method_kind, value: resource.contact_method ?? '' }];
  return listed
    .map(({ kind, value }) => ({ kind, value: value.trim() }))
    .filter(({ value }) => value !== '')
    .map(({ kind, value }) => actionFor(resource, kind, value));
}
