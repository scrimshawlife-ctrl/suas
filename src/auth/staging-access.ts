/**
 * STAGING admits only explicitly provisioned synthetic fixture principals.
 *
 * D-052 (review F3; owner decision 2026-11-05, recorded in suas-specs PR #66):
 * fake ID verification and public self sign-up are refused outside LOCAL and
 * TEST. Server authentication on STAGING checks the principal behind an
 * existing account or session, not only a new sign-up.
 */

import type { SuasConfig } from '../config/index.js';
import type { EnvironmentClass } from '../config/schema.js';
import { DEMO_FIXED_CODE_DESTINATION } from './demo-fixed-code.js';

export interface StagingAccess {
  readonly environment: EnvironmentClass;
  /** True only when public sign-up was explicitly enabled. Startup refuses that outside LOCAL/TEST. */
  readonly publicSignUp: boolean;
  /** Normalized synthetic emails. Empty on STAGING admits nobody. */
  readonly fixturePrincipals: readonly string[];
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
  const principals = [...config.stagingFixturePrincipals];
  if (config.demoFixedCode && !principals.includes(DEMO_FIXED_CODE_DESTINATION)) {
    principals.push(DEMO_FIXED_CODE_DESTINATION);
  }
  return {
    environment: config.environment,
    publicSignUp: config.publicSignUp,
    fixturePrincipals: principals,
  };
}

/** Public self sign-up is permitted only when LOCAL or TEST opted in. */
export function assertPublicSignUpPermitted(access: StagingAccess | undefined): void {
  if (
    access !== undefined &&
    access.publicSignUp &&
    (access.environment === 'LOCAL' || access.environment === 'TEST')
  ) {
    return;
  }
  throw new PublicSignUpRefusedError();
}

/**
 * True when STAGING must refuse this account. Other environment classes are
 * not gated here. A missing email is not an explicitly provisioned principal.
 */
export function stagingFixturePrincipalRefused(
  access: StagingAccess,
  email: string | undefined,
): boolean {
  if (access.environment !== 'STAGING') return false;
  if (email === undefined) return true;
  return !access.fixturePrincipals.includes(email.trim().toLowerCase());
}
