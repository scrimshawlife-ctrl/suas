/**
 * STAGING admits only explicitly provisioned synthetic fixture principals.
 *
 * D-052 (review F3; owner decision 2026-11-05, recorded in suas-specs PR #66):
 * fake ID verification and public self sign-up are refused outside LOCAL and
 * TEST. Server authentication on STAGING checks the principal behind an
 * existing account or session, not only a new sign-up.
 */

import type { SuasConfig } from '../config/index.js';
import type { EnvironmentClass, StagingFixturePrincipal } from '../config/schema.js';

export interface StagingAccess {
  readonly environment: EnvironmentClass;
  /** True only when public sign-up was explicitly enabled. Startup refuses that outside LOCAL/TEST. */
  readonly publicSignUp: boolean;
  /**
   * Explicit (tenant id, user id) pairs. Empty on STAGING admits nobody.
   * The demo account is not inserted when this list is empty or the flag is on.
   */
  readonly fixturePrincipals: readonly StagingFixturePrincipal[];
}

export class PublicSignUpRefusedError extends Error {
  readonly code = 'PUBLIC_SIGN_UP_REFUSED';
  readonly httpStatus = 403;

  constructor() {
    super('Public sign-up is refused outside LOCAL and TEST.');
    this.name = 'PublicSignUpRefusedError';
  }
}

export function stagingAccessFromConfig(config: SuasConfig): StagingAccess {
  return {
    environment: config.environment,
    publicSignUp: config.publicSignUp,
    fixturePrincipals: Object.freeze(
      config.stagingFixturePrincipals.map((principal) => Object.freeze({ ...principal })),
    ),
  };
}

/**
 * Public self sign-up is permitted only in LOCAL and TEST. STAGING and
 * PRODUCTION refuse it even when a caller sets `allowSignUp`.
 */
export function assertPublicSignUpPermitted(access: StagingAccess | undefined): void {
  if (access !== undefined && (access.environment === 'LOCAL' || access.environment === 'TEST')) {
    return;
  }
  throw new PublicSignUpRefusedError();
}

/**
 * True when STAGING must refuse this account. Other environment classes are
 * not gated here. Admission is the (tenant id, user id) pair. The same email
 * in another tenant, or the same tenant with a different user id, is refused.
 * An empty or missing registry admits nobody.
 */
export function stagingFixturePrincipalRefused(
  access: StagingAccess,
  principal: { readonly tenantId: string; readonly userId: string } | undefined,
): boolean {
  if (access.environment !== 'STAGING') return false;
  if (principal === undefined) return true;
  const tenantId = principal.tenantId.toLowerCase();
  const userId = principal.userId.toLowerCase();
  return !access.fixturePrincipals.some(
    (entry) => entry.tenantId === tenantId && entry.userId === userId,
  );
}
