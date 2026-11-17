import type { County } from '../api/types';

/** The served counties with their display names, in picker order. */
export const COUNTY_OPTIONS: readonly { value: County; label: string }[] = [
  { value: 'SANTA_CLARA', label: 'Santa Clara' },
  { value: 'SAN_MATEO', label: 'San Mateo' },
  { value: 'ALAMEDA', label: 'Alameda' },
  { value: 'SANTA_CRUZ', label: 'Santa Cruz' },
  { value: 'SAN_BENITO', label: 'San Benito' },
  { value: 'MERCED', label: 'Merced' },
  { value: 'STANISLAUS', label: 'Stanislaus' },
];

/** "Merced" for MERCED; an unknown value is shown as sent. */
export function countyName(county: string): string {
  return COUNTY_OPTIONS.find((option) => option.value === county)?.label ?? county;
}

/** "Marcus T." -> "Marcus". Falls back to `fallback` when there is no name. */
export function firstName(displayName: string | null | undefined, fallback = ''): string {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first : fallback;
}
