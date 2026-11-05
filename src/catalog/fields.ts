/**
 * Fields of a Resource Draft and their validation.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Catalog builder": a Resource Draft keeps its source link.
 * - SUAS-specs RESOURCES.md §2 (core fields), §6 (contact_method_kind needs a value),
 *   §10 (no generative resource invention, no eligibility invention).
 *
 * One schema serves model output and admin edits, so a draft can never hold values
 * the publish step would refuse. There is no verification field: the model never
 * sets `last_verified_at`.
 */

import { z } from 'zod';
import { SERVICE_CATEGORIES } from '../coordination/index.js';
import { CONTACT_METHOD_KINDS } from '../fulfillment/index.js';

/**
 * Launch counties, as the `suas_county` enum values that `users.county` carries.
 * Mirrors `SERVICE_COUNTIES` in src/identity/counties.ts.
 */
const DRAFT_COUNTIES = [
  'SANTA_CLARA',
  'SAN_MATEO',
  'ALAMEDA',
  'SANTA_CRUZ',
  'SAN_BENITO',
  'MERCED',
  'STANISLAUS',
] as const;

export const MAX_DRAFTS_PER_EXTRACTION = 25;

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullish();

/** Fields every draft carries, whether the model or an admin wrote them. */
export const draftFieldsBase = z
  .object({
    service_name: z.string().trim().min(1).max(200),
    category: z.enum(SERVICE_CATEGORIES),
    counties: z.array(z.enum(DRAFT_COUNTIES)).max(DRAFT_COUNTIES.length),
    eligibility: optionalText(1000),
    hours: optionalText(300),
    contact_method: optionalText(300),
    contact_method_kind: z.enum(CONTACT_METHOD_KINDS).nullish(),
    referral_method: optionalText(500),
    cost: optionalText(300),
  })
  .strict();

export const draftFieldsSchema = draftFieldsBase.refine(
  (fields) =>
    (fields.contact_method_kind ?? undefined) === undefined ||
    (fields.contact_method ?? undefined) !== undefined,
  { message: 'contact_method_kind requires a contact_method value.' },
);

export type DraftFields = z.infer<typeof draftFieldsSchema>;

/** An admin edit: any subset of the fields, at least one. `null` clears an optional field. */
export const draftChangesSchema = draftFieldsBase
  .partial()
  .refine((fields) => Object.keys(fields).length > 0, 'Send at least one field to change.');
export type DraftChanges = z.infer<typeof draftChangesSchema>;

/** The source link: an http(s) URL an administrator can open to check the draft. */
export const sourceLinkSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'source_link must be an http or https URL.');

/** JSON Schema the model sees for one extracted Resource. Keep in step with the zod above. */
export const draftFieldsJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['service_name', 'category', 'counties'],
  properties: {
    service_name: { type: 'string', description: 'Name of the service as the source gives it.' },
    category: {
      type: 'string',
      enum: [...SERVICE_CATEGORIES],
      description: 'The one category that fits. Omit the whole resource if none fits.',
    },
    counties: {
      type: 'array',
      items: { type: 'string', enum: [...DRAFT_COUNTIES] },
      description:
        'Launch counties the source says it serves. Use an empty list only when the source ' +
        'states no county limit.',
    },
    eligibility: { type: 'string', description: 'Eligibility exactly as the source states it.' },
    hours: { type: 'string', description: 'Opening hours as stated.' },
    contact_method: {
      type: 'string',
      description: 'Public phone, email or web address as stated.',
    },
    contact_method_kind: {
      type: 'string',
      enum: [...CONTACT_METHOD_KINDS],
      description: 'Kind of contact_method. Only with a contact_method.',
    },
    referral_method: { type: 'string', description: 'How a person is referred, as stated.' },
    cost: { type: 'string', description: 'Cost as stated.' },
  },
} as const;
