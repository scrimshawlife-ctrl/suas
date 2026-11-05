import type { County, Schemas, ServiceCategory } from '../../api/types';
import { COUNTIES, CATEGORIES, type ContactKind } from './labels';

export type ResourceDraft = Schemas['ResourceDraft'];
export type DraftEditRequest = Schemas['ResourceDraftEditRequest'];

/** Limits the API documents for a draft and for the pasted source. */
export const LIMITS = {
  sourceText: 30000,
  sourceLink: 2048,
  serviceName: 200,
  eligibility: 1000,
  hours: 300,
  contactMethod: 300,
  referralMethod: 500,
  cost: 300,
} as const;

export interface DraftFormValues {
  service_name: string;
  category: ServiceCategory | '';
  counties: County[];
  eligibility: string;
  hours: string;
  contact_method: string;
  contact_method_kind: ContactKind | '';
  referral_method: string;
  cost: string;
}

export type DraftFormErrors = Partial<Record<keyof DraftFormValues, string>>;

export function draftToForm(draft: ResourceDraft): DraftFormValues {
  return {
    service_name: draft.service_name,
    category: draft.category,
    counties: COUNTIES.filter((county) => draft.counties.includes(county)),
    eligibility: draft.eligibility ?? '',
    hours: draft.hours ?? '',
    contact_method: draft.contact_method ?? '',
    contact_method_kind: draft.contact_method_kind ?? '',
    referral_method: draft.referral_method ?? '',
    cost: draft.cost ?? '',
  };
}

const optionalFields = [
  ['eligibility', 'Eligibility', LIMITS.eligibility],
  ['hours', 'Hours', LIMITS.hours],
  ['contact_method', 'Contact method', LIMITS.contactMethod],
  ['referral_method', 'Referral method', LIMITS.referralMethod],
  ['cost', 'Cost', LIMITS.cost],
] as const;

export function validateDraftForm(values: DraftFormValues): DraftFormErrors {
  const errors: DraftFormErrors = {};
  const name = values.service_name.trim();
  if (name === '') errors.service_name = 'Enter the service name.';
  else if (name.length > LIMITS.serviceName)
    errors.service_name = `The service name is over ${LIMITS.serviceName} characters.`;
  if (!CATEGORIES.includes(values.category as ServiceCategory))
    errors.category = 'Choose a category.';
  for (const [field, label, max] of optionalFields) {
    if (values[field].trim().length > max)
      errors[field] = `${label} is over ${max.toLocaleString('en-US')} characters.`;
  }
  if (values.contact_method_kind !== '' && values.contact_method.trim() === '')
    errors.contact_method_kind = 'Add a contact method, or choose no kind.';
  return errors;
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

/**
 * The edit body: only the fields that differ from the saved draft, so a save never
 * rewrites what the admin did not touch. A cleared optional field is sent as null.
 * Returns null when nothing changed.
 */
export function buildEditPayload(
  draft: ResourceDraft,
  values: DraftFormValues,
): DraftEditRequest | null {
  const saved = draftToForm(draft);
  const payload: DraftEditRequest = {};
  if (values.service_name.trim() !== saved.service_name)
    payload.service_name = values.service_name.trim();
  if (values.category !== saved.category && values.category !== '')
    payload.category = values.category;
  const counties = COUNTIES.filter((county) => values.counties.includes(county));
  if (counties.join() !== saved.counties.join()) payload.counties = counties;
  for (const [field] of optionalFields) {
    if (values[field].trim() !== saved[field].trim()) payload[field] = orNull(values[field]);
  }
  if (values.contact_method_kind !== saved.contact_method_kind) {
    payload.contact_method_kind =
      values.contact_method_kind === '' ? null : values.contact_method_kind;
  }
  return Object.keys(payload).length === 0 ? null : payload;
}

export interface ExtractValues {
  source_text: string;
  source_link: string;
}
export type ExtractErrors = Partial<Record<keyof ExtractValues, string>>;

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function validateExtract(values: ExtractValues): ExtractErrors {
  const errors: ExtractErrors = {};
  const text = values.source_text.trim();
  if (text === '') errors.source_text = 'Paste the source text.';
  else if (text.length > LIMITS.sourceText)
    errors.source_text = `The text is over ${LIMITS.sourceText.toLocaleString('en-US')} characters. Shorten it and try again.`;
  const link = values.source_link.trim();
  if (link === '') errors.source_link = 'Enter the link to the source.';
  else if (link.length > LIMITS.sourceLink)
    errors.source_link = `The link is over ${LIMITS.sourceLink.toLocaleString('en-US')} characters.`;
  else if (!isHttpUrl(link))
    errors.source_link = 'Enter a web link that starts with http:// or https://.';
  return errors;
}
