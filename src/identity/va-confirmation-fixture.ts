/**
 * Deterministic VA confirmation fixture (LOCAL and TEST only): no network, no key.
 *
 * suas-specs #72 R9.1 (proposal) `fixture` mode and D035_VA_CONFIRMATION_ADAPTER.md §15
 * (synthetic vectors, clearly labeled, never production evidence). The outcome depends
 * only on `zipCode`, so tests and web e2e can pick a result with a synthetic person. An
 * unlisted ZIP fails closed as NOT_CONFIRMED PERSON_NOT_FOUND, never VERIFIED.
 */

import type {
  VaConfirmationProjection,
  VeteranConfirmationPort,
  VeteranConfirmationResult,
} from './va-confirmation.js';

/** The fixture's synthetic ZIP vectors. `REQUEST_INVALID` stands in for a VA 400. */
export const VA_CONFIRMATION_FIXTURE_ZIPS = {
  VERIFIED: '00001',
  PERSON_NOT_FOUND: '00002',
  NOT_TITLE_38: '00003',
  MORE_RESEARCH_REQUIRED: '00004',
  UNAVAILABLE_ERROR: '00005',
  REQUEST_INVALID: '00006',
} as const;

const OUTCOMES: Readonly<Record<string, VeteranConfirmationResult>> = {
  [VA_CONFIRMATION_FIXTURE_ZIPS.VERIFIED]: { status: 'VERIFIED' },
  [VA_CONFIRMATION_FIXTURE_ZIPS.PERSON_NOT_FOUND]: {
    status: 'NOT_CONFIRMED',
    notConfirmedReason: 'PERSON_NOT_FOUND',
  },
  [VA_CONFIRMATION_FIXTURE_ZIPS.NOT_TITLE_38]: {
    status: 'NOT_CONFIRMED',
    notConfirmedReason: 'NOT_TITLE_38',
  },
  [VA_CONFIRMATION_FIXTURE_ZIPS.MORE_RESEARCH_REQUIRED]: {
    status: 'NOT_CONFIRMED',
    notConfirmedReason: 'MORE_RESEARCH_REQUIRED',
  },
  [VA_CONFIRMATION_FIXTURE_ZIPS.UNAVAILABLE_ERROR]: {
    status: 'UNAVAILABLE',
    notConfirmedReason: 'ERROR',
    failureClass: 'PROVIDER_UNAVAILABLE',
  },
  [VA_CONFIRMATION_FIXTURE_ZIPS.REQUEST_INVALID]: {
    status: 'UNAVAILABLE',
    failureClass: 'REQUEST_INVALID',
  },
};

const FAIL_CLOSED: VeteranConfirmationResult = {
  status: 'NOT_CONFIRMED',
  notConfirmedReason: 'PERSON_NOT_FOUND',
};

export class FixtureVeteranConfirmation implements VeteranConfirmationPort {
  readonly implementation = 'va-confirmation-fixture';
  readonly providerEnvironment = 'NONE' as const;

  confirm(projection: VaConfirmationProjection): Promise<VeteranConfirmationResult> {
    return Promise.resolve(OUTCOMES[projection.zipCode] ?? FAIL_CLOSED);
  }
}
