/**
 * The reusable authorization checks for requesting help.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 ("Every Veteran must pass ID scan +
 * selfie before requesting help"; "a signed-in person can only help others" until
 * then) and §4.3 F10.
 *
 * `requireVerifiedVeteran` guards every route that is the Veteran's own: requesting
 * help, Resources, Check-Ins, Trusted Contacts, Consent Grants. Routes where a
 * person helps someone else (helper list, accept, accepter commands, chat as the
 * accepter) and the crisis screen must not call it. `requireCounty` guards routes
 * that match by county: requesting help and the helper list.
 *
 * Both read current state on every call (AUTH.md §5), so a revoked scan stops
 * working at once. Both accept a pool or a transaction client.
 */

import type { AuthContext } from '../authz/context.js';
import type { Queryable } from '../db/transaction.js';
import { hasPassedIdScan } from './id-scan.js';
import { findUserById } from './users.js';

export class VeteranVerificationRequiredError extends Error {
  readonly code = 'VERIFICATION_REQUIRED';
  readonly httpStatus = 403;

  constructor() {
    super('Verify your ID with a scan and selfie before using this.');
    this.name = 'VeteranVerificationRequiredError';
  }
}

export class CountyRequiredError extends Error {
  readonly code = 'COUNTY_REQUIRED';
  readonly httpStatus = 422;

  constructor() {
    super('Choose your county before using this.');
    this.name = 'CountyRequiredError';
  }
}

/** Deny unless the signed-in person has a passed ID scan + selfie check. */
export async function requireVerifiedVeteran(db: Queryable, context: AuthContext): Promise<void> {
  if (!(await hasPassedIdScan(db, context.tenantId, context.userId))) {
    throw new VeteranVerificationRequiredError();
  }
}

/** Deny unless the signed-in person has chosen a county. */
export async function requireCounty(db: Queryable, context: AuthContext): Promise<void> {
  const user = await findUserById(db, context.tenantId, context.userId);
  if (user?.county === undefined) throw new CountyRequiredError();
}
