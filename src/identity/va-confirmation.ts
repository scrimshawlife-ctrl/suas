/**
 * VA Veteran Confirmation port: the v1 request gate proposed by suas-specs #72 R9.1
 * (proposal, not released) under D-035 (D035_VA_CONFIRMATION_ADAPTER.md §4–§15).
 *
 * SUAS sends one demographic projection, `VA_CONFIRMATION_V1_REQUIRED_ONLY`, and keeps
 * only the normalized result. The projection values never leave this boundary as
 * stored, logged or audited data. The port never throws for provider failures: they
 * come back as `UNAVAILABLE` with a bounded failure class (D035 §11).
 */

import { z } from 'zod';
import type { VaNotConfirmedReason } from './veteran-verification.js';

/** R9.1: the eight required VA fields, `country` fixed to USA, nothing else. */
export const VA_CONFIRMATION_PROJECTION_ID = 'VA_CONFIRMATION_V1_REQUIRED_ONLY' as const;

/** Recorded as `source_contract_version`; the provider contract this adapter speaks. */
export const VA_CONFIRMATION_CONTRACT_VERSION = 'va-veteran-confirmation-v1' as const;

/** The only base URL `sandbox` mode accepts (R9.1 "sandbox base URL only"). */
export const VA_CONFIRMATION_SANDBOX_BASE_URL =
  'https://sandbox-api.va.gov/services/veteran-confirmation/v1';

/** D035 §11 adapter failure classes; migration 0022 bounds the column to this list. */
export const VA_CONFIRMATION_FAILURE_CLASSES = [
  'CONFIGURATION_INVALID',
  'AUTHENTICATION_REJECTED',
  'REQUEST_INVALID',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_REASON_UNKNOWN',
  'TIMEOUT',
  'NETWORK_ERROR',
] as const;
export type VaConfirmationFailureClass = (typeof VA_CONFIRMATION_FAILURE_CLASSES)[number];

/** `NONE` is the no-network fixture. PRODUCTION stays refused until D-035 settles. */
export type VaProviderEnvironment = 'NONE' | 'SANDBOX' | 'PRODUCTION';

// VA's request patterns (OpenAPI read 2026-11-10). The length bound is SUAS-side input
// hygiene, not a VA rule.
const MAX_FIELD_LENGTH = 256;
const NAME = /^[A-Za-z]+([-'/\\\s][A-Za-z]+){0,9}$/;
const STREET = /^[a-zA-Z0-9\s,'#.\-/\\]*$/;
const CITY = /^[a-zA-Z0-9\s,'.\-/\\]+$/;
const REGION = /^[a-zA-Z]+(?:[\s-][a-zA-Z]+){0,9}$/;
const ZIP = /^[A-Za-z0-9 -]{1,16}$/;
const BIRTH_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const field = (pattern: RegExp) => z.string().min(1).max(MAX_FIELD_LENGTH).regex(pattern);

/** A real calendar date strictly before today (UTC). */
export function isPastCalendarDate(value: string, now: Date = new Date()): boolean {
  const match = BIRTH_DATE.exec(value);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const real =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return real && date.getTime() < today;
}

const projectionFields = {
  firstName: field(NAME),
  lastName: field(NAME),
  birthDate: z.string().refine((value) => isPastCalendarDate(value)),
  streetAddressLine1: field(STREET),
  city: field(CITY),
  state: field(REGION),
  zipCode: field(ZIP),
};

/** The exact projection sent to VA. Unknown keys are refused (D035 §8, §14 item 5). */
export const vaConfirmationProjectionSchema = z
  .object({ ...projectionFields, country: z.literal('USA') })
  .strict();
export type VaConfirmationProjection = z.infer<typeof vaConfirmationProjectionSchema>;

/**
 * The pre-call notice version the person must have seen (R9.1 D6; VETERAN_VERIFICATION §9).
 * The wording lives in suas-specs VA_CONFIRMATION_FLOW.md and the web client; a change to
 * it needs a new version.
 */
export const VA_NOTICE_V1 = 'va-notice-v1' as const;

/** The confirm body carries an old or missing notice version. */
export class VaNoticeVersionRequiredError extends Error {
  readonly code = 'VA_NOTICE_VERSION_REQUIRED';
  readonly httpStatus = 400;

  constructor() {
    super(`Show the current VA notice (${VA_NOTICE_V1}) before sending details to VA.`);
    this.name = 'VaNoticeVersionRequiredError';
  }
}

/**
 * The API body: the projection, where `country` may be left out and is then USA, plus the
 * notice version (checked first, see `VaNoticeVersionRequiredError`).
 */
export const vaConfirmationRequestSchema = z
  .object({
    ...projectionFields,
    country: z.literal('USA').optional(),
    noticeVersion: z.literal(VA_NOTICE_V1),
  })
  .strict()
  .transform(
    ({
      noticeVersion,
      ...body
    }): { noticeVersion: string; projection: VaConfirmationProjection } => ({
      noticeVersion,
      projection: { ...body, country: 'USA' },
    }),
  );

/** Projection field names, for log redaction. */
export const VA_CONFIRMATION_PROJECTION_FIELDS = [
  'firstName',
  'lastName',
  'birthDate',
  'streetAddressLine1',
  'city',
  'state',
  'country',
  'zipCode',
] as const;

export interface VeteranConfirmationResult {
  readonly status: 'VERIFIED' | 'NOT_CONFIRMED' | 'UNAVAILABLE';
  readonly notConfirmedReason?: VaNotConfirmedReason;
  readonly failureClass?: VaConfirmationFailureClass;
}

export interface VeteranConfirmationPort {
  readonly implementation: string;
  readonly providerEnvironment: VaProviderEnvironment;
  /** One provider query per call. Resolves for every provider outcome. */
  confirm(projection: VaConfirmationProjection): Promise<VeteranConfirmationResult>;
}

/** No confirmation adapter is configured (`SUAS_VA_CONFIRMATION_MODE=disabled`). */
export class VeteranConfirmationUnavailableError extends Error {
  readonly code = 'ID_VERIFICATION_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor() {
    super('Veteran confirmation is not available right now. Try again later.');
    this.name = 'VeteranConfirmationUnavailableError';
  }
}
