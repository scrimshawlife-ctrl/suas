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
  /** Plain words for the chip. The API has no verified date, only a band. */
  label: string;
  chip: 'ok' | 'stale';
  /** Show "This listing may be out of date." */
  outOfDate: boolean;
}

export function describeFreshness(resource: CatalogResource): Freshness {
  const outOfDate = resource.stale_warning || resource.freshness === 'STALE';
  switch (resource.freshness) {
    case 'FRESH':
      return { label: 'Checked recently', chip: 'ok', outOfDate };
    case 'AGING':
      return { label: 'Checked a while ago', chip: 'stale', outOfDate };
    case 'STALE':
      return { label: 'Not checked recently', chip: 'stale', outOfDate };
    default:
      return { label: 'Not checked yet', chip: 'stale', outOfDate };
  }
}

export type ContactAction =
  | { kind: 'phone'; label: string; href: string }
  | { kind: 'email'; label: string; href: string }
  | { kind: 'url'; label: string; href: string }
  /** Stored as free text: shown as written, not a link. */
  | { kind: 'text'; text: string }
  | { kind: 'none' };

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

/** What to offer for a listing's contact method, by `contact_method_kind`. */
export function contactAction(resource: CatalogResource): ContactAction {
  const method = resource.contact_method?.trim() ?? '';
  if (method === '') return { kind: 'none' };
  switch (resource.contact_method_kind) {
    case 'PHONE': {
      const href = phoneHref(method);
      return href === null
        ? { kind: 'text', text: method }
        : { kind: 'phone', label: `Call ${method}`, href };
    }
    case 'EMAIL': {
      const href = mailHref(method);
      return href === null
        ? { kind: 'text', text: method }
        : { kind: 'email', label: `Email ${method}`, href };
    }
    case 'URL': {
      try {
        const url = new URL(method);
        if (url.protocol === 'https:' || url.protocol === 'http:') {
          return { kind: 'url', label: 'Visit website', href: url.href };
        }
      } catch {
        // Not a web address: show it as written.
      }
      return { kind: 'text', text: method };
    }
    default:
      return { kind: 'text', text: method };
  }
}
