import type { County, ServiceCategory } from '../../api/types';

export type ContactKind = 'PHONE' | 'EMAIL' | 'URL' | 'FREEFORM';
export type DraftStatus = 'DRAFT' | 'PUBLISHED' | 'REJECTED';

/** The seven launch counties, in the order the API documents them. */
export const COUNTIES: readonly County[] = [
  'SANTA_CLARA',
  'SAN_MATEO',
  'ALAMEDA',
  'SANTA_CRUZ',
  'SAN_BENITO',
  'MERCED',
  'STANISLAUS',
];

export const COUNTY_LABELS: Record<County, string> = {
  SANTA_CLARA: 'Santa Clara',
  SAN_MATEO: 'San Mateo',
  ALAMEDA: 'Alameda',
  SANTA_CRUZ: 'Santa Cruz',
  SAN_BENITO: 'San Benito',
  MERCED: 'Merced',
  STANISLAUS: 'Stanislaus',
};

export const CATEGORIES: readonly ServiceCategory[] = [
  'FOOD',
  'TRANSPORTATION',
  'SHELTER',
  'PEER_SUPPORT',
];

export const CATEGORY_LABELS: Record<ServiceCategory, string> = {
  FOOD: 'Food',
  TRANSPORTATION: 'Transportation',
  SHELTER: 'Shelter',
  PEER_SUPPORT: 'Peer support',
};

export const CONTACT_KINDS: readonly ContactKind[] = ['PHONE', 'EMAIL', 'URL', 'FREEFORM'];

export const CONTACT_KIND_LABELS: Record<ContactKind, string> = {
  PHONE: 'Phone number',
  EMAIL: 'Email address',
  URL: 'Web address',
  FREEFORM: 'Other',
};

/** Tab words for the status filter. REJECTED is what the Discard command produces. */
export const STATUS_LABELS: Record<DraftStatus, string> = {
  DRAFT: 'To review',
  PUBLISHED: 'Published',
  REJECTED: 'Discarded',
};

export const STATUSES: readonly DraftStatus[] = ['DRAFT', 'PUBLISHED', 'REJECTED'];

export function isDraftStatus(value: string | null): value is DraftStatus {
  return value === 'DRAFT' || value === 'PUBLISHED' || value === 'REJECTED';
}

export function countiesLabel(counties: readonly County[]): string {
  if (counties.length === 0) return 'No county limit stated';
  return counties.map((county) => COUNTY_LABELS[county]).join(', ');
}
