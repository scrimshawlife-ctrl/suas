/**
 * The reusable authorization checks for requesting help.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 ("a signed-in person can only help others"
 * until verified) and §4.3 F10. suas-specs #72 R9.1 (proposal) makes a VERIFIED VA
 * Veteran Confirmation the gate in place of the ID scan + selfie.
 *
 * `requireVerifiedVeteran` guards every route that is the Veteran's own: requesting
 * help, Resources, Check-Ins, Trusted Contacts, Consent Grants. Routes where a
 * person helps someone else (helper list, accept, accepter commands, chat as the
 * accepter) and the crisis screen must not call it. `requireCounty` guards routes
 * that match by county: requesting help and the helper list.
 *
 * Both read current state on every call (AUTH.md §5), so a revoked standing stops
 * working at once. Both accept a pool or a transaction client.
 */

import type { AuthContext } from '../authz/context.js';
import type { Queryable } from '../db/transaction.js';
import { CountyRequiredError } from '../coordination/open-requests.js';
import { hasConfirmedVeteranStatus } from './va-confirmation-store.js';
import { findUserById } from './users.js';

export class VeteranVerificationRequiredError extends Error {
  readonly code = 'VERIFICATION_REQUIRED';
  readonly httpStatus = 403;

  constructor() {
    super('Confirm your Veteran status before using this.');
    this.name = 'VeteranVerificationRequiredError';
  }
}

/** Deny unless the person's newest VA Veteran Confirmation result is VERIFIED. */
export async function requireVerifiedVeteran(db: Queryable, context: AuthContext): Promise<void> {
  if (!(await hasConfirmedVeteranStatus(db, context.tenantId, context.userId))) {
    throw new VeteranVerificationRequiredError();
  }
}

/** Deny unless the signed-in person has chosen a county. */
export async function requireCounty(db: Queryable, context: AuthContext): Promise<void> {
  const user = await findUserById(db, context.tenantId, context.userId);
  if (user?.county === undefined) throw new CountyRequiredError();
}
