import type { ServiceCategory } from '../../api/types';

export const SUMMARY_MAX = 280;
export const TIMING_MAX = 120;
export const MEETING_PLACE_MAX = 200;
export const INTAKE_TEXT_MAX = 2000;

export const CATEGORIES: readonly ServiceCategory[] = [
  'PEER_SUPPORT',
  'FOOD',
  'TRANSPORTATION',
  'SHELTER',
];

/** FOOD, TRANSPORTATION and SHELTER need a meeting place; PEER_SUPPORT does not (plan 2.1). */
export function meetingPlaceRequired(category: ServiceCategory | ''): boolean {
  return category === 'FOOD' || category === 'TRANSPORTATION' || category === 'SHELTER';
}

export function isCategory(value: string | null | undefined): value is ServiceCategory {
  return (CATEGORIES as readonly string[]).includes(value ?? '');
}

/** What the person is editing. Empty strings mean "not given". */
export interface RequestFields {
  category: ServiceCategory | '';
  summary: string;
  timing: string;
  meetingPlace: string;
}

export type FieldErrors = Partial<Record<keyof RequestFields, string>>;

export function validateRequestFields(fields: RequestFields): FieldErrors {
  const errors: FieldErrors = {};
  const summary = fields.summary.trim();
  if (fields.category === '') errors.category = 'Choose what you need.';
  if (summary === '') errors.summary = 'Tell us what you need.';
  else if (summary.length > SUMMARY_MAX) {
    errors.summary = `Use ${SUMMARY_MAX} characters or fewer.`;
  }
  if (fields.timing.trim().length > TIMING_MAX) {
    errors.timing = `Use ${TIMING_MAX} characters or fewer.`;
  }
  const place = fields.meetingPlace.trim();
  if (place.length > MEETING_PLACE_MAX) {
    errors.meetingPlace = `Use ${MEETING_PLACE_MAX} characters or fewer.`;
  } else if (place === '' && meetingPlaceRequired(fields.category)) {
    errors.meetingPlace = 'Tell us where the helper should meet you.';
  }
  return errors;
}

/** Body for the plain form (`POST /service-requests`): empty optional fields are left out. */
export function toFormBody(fields: RequestFields) {
  const timing = fields.timing.trim();
  const place = fields.meetingPlace.trim();
  return {
    category: fields.category as ServiceCategory,
    summary: fields.summary.trim(),
    ...(timing === '' ? {} : { timing }),
    ...(place === '' ? {} : { meeting_place: place }),
  };
}
