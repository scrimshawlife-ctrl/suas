import type { components } from '../../api/schema';

/** The VA_CONFIRMATION_V1_REQUIRED_ONLY body (suas-specs #72 R9.1, proposal). */
export type VaConfirmBody = components['schemas']['VaConfirmationRequest'];

/**
 * The notice shown above the form (VA_CONFIRMATION_FLOW §4.1, `VA_NOTICE_V1`). Every confirm
 * body names it, and the API stores it on the attempt; change both when the wording changes.
 */
export const VA_NOTICE_VERSION = 'va-notice-v1';

/** What the person types. Kept only in component state, never stored or put in the URL. */
export interface VerifyFormValues {
  firstName: string;
  lastName: string;
  birthMonth: string;
  birthDay: string;
  birthYear: string;
  street: string;
  city: string;
  state: string;
  zip: string;
}

export type VerifyField =
  'firstName' | 'lastName' | 'birthDate' | 'street' | 'city' | 'state' | 'zip';
export type VerifyFormErrors = Partial<Record<VerifyField, string>>;

export const EMPTY_VERIFY_FORM: VerifyFormValues = {
  firstName: '',
  lastName: '',
  birthMonth: '',
  birthDay: '',
  birthYear: '',
  street: '',
  city: '',
  state: '',
  zip: '',
};

/** Field order on screen, labels for the error summary, and the control each error links to. */
export const VERIFY_FIELDS: readonly { field: VerifyField; label: string; controlId: string }[] = [
  { field: 'firstName', label: 'First name', controlId: 'va-first-name' },
  { field: 'lastName', label: 'Last name', controlId: 'va-last-name' },
  { field: 'birthDate', label: 'Date of birth', controlId: 'va-birth-month' },
  { field: 'street', label: 'Street address', controlId: 'va-street' },
  { field: 'city', label: 'City', controlId: 'va-city' },
  { field: 'state', label: 'State', controlId: 'va-state' },
  { field: 'zip', label: 'ZIP code', controlId: 'va-zip' },
];

/** The 50 states, DC and the inhabited territories, by USPS code. */
export const US_STATE_OPTIONS: readonly { value: string; label: string }[] = (
  [
    ['AL', 'Alabama'],
    ['AK', 'Alaska'],
    ['AS', 'American Samoa'],
    ['AZ', 'Arizona'],
    ['AR', 'Arkansas'],
    ['CA', 'California'],
    ['CO', 'Colorado'],
    ['CT', 'Connecticut'],
    ['DE', 'Delaware'],
    ['DC', 'District of Columbia'],
    ['FL', 'Florida'],
    ['GA', 'Georgia'],
    ['GU', 'Guam'],
    ['HI', 'Hawaii'],
    ['ID', 'Idaho'],
    ['IL', 'Illinois'],
    ['IN', 'Indiana'],
    ['IA', 'Iowa'],
    ['KS', 'Kansas'],
    ['KY', 'Kentucky'],
    ['LA', 'Louisiana'],
    ['ME', 'Maine'],
    ['MD', 'Maryland'],
    ['MA', 'Massachusetts'],
    ['MI', 'Michigan'],
    ['MN', 'Minnesota'],
    ['MS', 'Mississippi'],
    ['MO', 'Missouri'],
    ['MT', 'Montana'],
    ['NE', 'Nebraska'],
    ['NV', 'Nevada'],
    ['NH', 'New Hampshire'],
    ['NJ', 'New Jersey'],
    ['NM', 'New Mexico'],
    ['NY', 'New York'],
    ['NC', 'North Carolina'],
    ['ND', 'North Dakota'],
    ['MP', 'Northern Mariana Islands'],
    ['OH', 'Ohio'],
    ['OK', 'Oklahoma'],
    ['OR', 'Oregon'],
    ['PA', 'Pennsylvania'],
    ['PR', 'Puerto Rico'],
    ['RI', 'Rhode Island'],
    ['SC', 'South Carolina'],
    ['SD', 'South Dakota'],
    ['TN', 'Tennessee'],
    ['TX', 'Texas'],
    ['VI', 'U.S. Virgin Islands'],
    ['UT', 'Utah'],
    ['VT', 'Vermont'],
    ['VA', 'Virginia'],
    ['WA', 'Washington'],
    ['WV', 'West Virginia'],
    ['WI', 'Wisconsin'],
    ['WY', 'Wyoming'],
  ] as const
).map(([value, label]) => ({ value, label }));

// VA's request patterns, mirrored from src/identity/va-confirmation.ts so people see
// field-level messages before sending. The server stays the authority.
const MAX_LENGTH = 256;
const NAME = /^[A-Za-z]+([-'/\\\s][A-Za-z]+){0,9}$/;
const STREET = /^[a-zA-Z0-9\s,'#.\-/\\]*$/;
const CITY = /^[a-zA-Z0-9\s,'.\-/\\]+$/;
const ZIP = /^[A-Za-z0-9 -]{1,16}$/;

/** Trims, and turns the curly apostrophes phone keyboards type into the one VA accepts. */
function clean(value: string): string {
  return value.trim().replace(/[‘’]/g, "'");
}

/** YYYY-MM-DD from the three parts, or null when they do not make a real calendar date. */
export function birthDateOf(values: VerifyFormValues): string | null {
  const [month, day, year] = [
    clean(values.birthMonth),
    clean(values.birthDay),
    clean(values.birthYear),
  ];
  if (!/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day) || !/^\d{4}$/.test(year)) return null;
  const [m, d, y] = [Number(month), Number(day), Number(year)];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function nameError(value: string, label: string): string | undefined {
  if (value === '') return `Enter your ${label}.`;
  if (value.length > MAX_LENGTH) return `Use ${MAX_LENGTH} characters or fewer.`;
  if (!NAME.test(value)) {
    return 'Use letters only, with no numbers or accents. One space, hyphen or apostrophe can go between letters.';
  }
  return undefined;
}

function birthDateError(values: VerifyFormValues, now: Date): string | undefined {
  const parts = [values.birthMonth, values.birthDay, values.birthYear].map(clean);
  if (parts.every((part) => part === '')) return 'Enter your date of birth.';
  const date = birthDateOf(values);
  if (date === null) return 'Enter a real date of birth, with a 4-digit year, like 4 28 1986.';
  // Same rule as the server: a date before today in UTC.
  if (date >= now.toISOString().slice(0, 10)) return 'Your date of birth must be in the past.';
  return undefined;
}

function textError(
  value: string,
  pattern: RegExp,
  empty: string,
  invalid: string,
): string | undefined {
  if (value === '') return empty;
  if (value.length > MAX_LENGTH) return `Use ${MAX_LENGTH} characters or fewer.`;
  if (!pattern.test(value)) return invalid;
  return undefined;
}

/** Empty object means the form can be sent. */
export function validateVerifyForm(
  values: VerifyFormValues,
  now: Date = new Date(),
): VerifyFormErrors {
  const found: VerifyFormErrors = {
    firstName: nameError(clean(values.firstName), 'first name'),
    lastName: nameError(clean(values.lastName), 'last name'),
    birthDate: birthDateError(values, now),
    street: textError(
      clean(values.street),
      STREET,
      'Enter your street address.',
      "Use letters, numbers, spaces and these marks only: , ' # . - /",
    ),
    city: textError(
      clean(values.city),
      CITY,
      'Enter your city or town.',
      "Use letters, numbers, spaces and these marks only: , ' . - /",
    ),
    state: US_STATE_OPTIONS.some((option) => option.value === values.state)
      ? undefined
      : 'Choose your state or territory.',
    zip: textError(
      clean(values.zip),
      ZIP,
      'Enter your ZIP code.',
      'Use numbers, letters, spaces or hyphens only, 16 at most, like 94110.',
    ),
  };
  return Object.fromEntries(Object.entries(found).filter(([, message]) => message !== undefined));
}

/**
 * The request body, from values that passed `validateVerifyForm`. Country is always USA; the
 * notice version records which notice the person saw before sending.
 */
export function toConfirmBody(values: VerifyFormValues): VaConfirmBody {
  return {
    firstName: clean(values.firstName),
    lastName: clean(values.lastName),
    birthDate: birthDateOf(values) ?? '',
    streetAddressLine1: clean(values.street),
    city: clean(values.city),
    state: values.state,
    zipCode: clean(values.zip),
    country: 'USA',
    noticeVersion: VA_NOTICE_VERSION,
  };
}
