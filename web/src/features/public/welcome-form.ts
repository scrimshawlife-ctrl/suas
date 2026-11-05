import type { County } from '../../api/types';

export const COUNTY_OPTIONS: readonly { value: County; label: string }[] = [
  { value: 'SANTA_CLARA', label: 'Santa Clara' },
  { value: 'SAN_MATEO', label: 'San Mateo' },
  { value: 'ALAMEDA', label: 'Alameda' },
  { value: 'SANTA_CRUZ', label: 'Santa Cruz' },
  { value: 'SAN_BENITO', label: 'San Benito' },
  { value: 'MERCED', label: 'Merced' },
  { value: 'STANISLAUS', label: 'Stanislaus' },
];

export const DISPLAY_NAME_MAX = 40;

export interface WelcomeErrors {
  displayName?: string;
  county?: string;
}

export function isCounty(value: string): value is County {
  return COUNTY_OPTIONS.some((option) => option.value === value);
}

/** Empty object means the form can be saved. */
export function validateWelcome(displayName: string, county: string): WelcomeErrors {
  const errors: WelcomeErrors = {};
  const name = displayName.trim();
  if (name.length === 0) errors.displayName = 'Enter the name other veterans will see.';
  else if (name.length > DISPLAY_NAME_MAX)
    errors.displayName = `Use ${DISPLAY_NAME_MAX} characters or fewer.`;
  if (!isCounty(county)) errors.county = 'Choose your county.';
  return errors;
}
