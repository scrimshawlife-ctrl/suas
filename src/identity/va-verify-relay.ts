/**
 * Wire contract of the outside-VPC VA verify function (VA_CONFIRMATION_FLOW W9 item 4, released
 * in 0.10.0). The API sends one projection; the function answers with only the normalized result
 * and failure class. snake_case JSON, like the email relay.
 */

import { z } from 'zod';
import {
  VA_CONFIRMATION_FAILURE_CLASSES,
  vaConfirmationProjectionSchema,
  type VeteranConfirmationResult,
} from './va-confirmation.js';

/** The request is the projection itself; unknown keys are refused (D035 §8). */
export const vaVerifyRequestSchema = vaConfirmationProjectionSchema;

// Each status carries exactly what D035 §10 lets it carry, so a malformed answer cannot read
// as a more definite one.
export const vaVerifyResponseSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('VERIFIED') }).strict(),
  z
    .object({
      status: z.literal('NOT_CONFIRMED'),
      not_confirmed_reason: z.enum(['PERSON_NOT_FOUND', 'NOT_TITLE_38', 'MORE_RESEARCH_REQUIRED']),
    })
    .strict(),
  z
    .object({
      status: z.literal('UNAVAILABLE'),
      not_confirmed_reason: z.literal('ERROR').optional(),
      failure_class: z.enum(VA_CONFIRMATION_FAILURE_CLASSES),
    })
    .strict(),
]);
export type VaVerifyResponse = z.infer<typeof vaVerifyResponseSchema>;

export function toVaVerifyResponse(result: VeteranConfirmationResult): unknown {
  return {
    status: result.status,
    ...(result.notConfirmedReason !== undefined
      ? { not_confirmed_reason: result.notConfirmedReason }
      : {}),
    ...(result.failureClass !== undefined ? { failure_class: result.failureClass } : {}),
  };
}

export function fromVaVerifyResponse(response: VaVerifyResponse): VeteranConfirmationResult {
  if (response.status === 'VERIFIED') return { status: 'VERIFIED' };
  if (response.status === 'NOT_CONFIRMED') {
    return { status: 'NOT_CONFIRMED', notConfirmedReason: response.not_confirmed_reason };
  }
  return {
    status: 'UNAVAILABLE',
    ...(response.not_confirmed_reason !== undefined
      ? { notConfirmedReason: response.not_confirmed_reason }
      : {}),
    failureClass: response.failure_class,
  };
}
