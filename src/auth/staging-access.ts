/**
 * STAGING admits only explicitly provisioned synthetic fixture principals.
 *
 * D-052 (review F3; owner decision 2026-11-05, recorded in suas-specs PR #66):
 * fake ID verification and public self sign-up are refused outside LOCAL and
 * TEST. Server authentication on STAGING checks the principal behind an
 * existing account or session, not only a new sign-up.
 *
 * R16.1 (contributor proposal, not released; owner decision pending): STAGING public demo mode
 * lifts that gate and permits self sign-up there. Startup refuses it in PRODUCTION.
 */

import type { SuasConfig } from '../config/index.js';
import type {
  EnvironmentClass,
  PublicDemoLimits,
  StagingFixturePrincipal,
} from '../config/schema.js';
import { isSyntheticEmail } from '../testing/fixture-boundary.js';

const PLUS_TAG = /^[a-z0-9-]{1,32}$/;

/**
 * May this address belong to a STAGING fixture principal? Yes if it is synthetic, or a plus
 * address `local+tag@domain` of the configured fixture mailbox (R11.7, specs #75, released
 * in 0.10.0), so emailed codes reach the owner's inbox. The bare mailbox is not.
 */
export function isStagingFixtureAddress(email: string, mailbox: string | undefined): boolean {
  if (isSyntheticEmail(email)) return true;
  if (mailbox === undefined) return false;
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  const plus = normalized.indexOf('+');
  if (plus < 1 || at < plus) return false;
  const tag = normalized.slice(plus + 1, at);
  const base = normalized.slice(0, plus) + normalized.slice(at);
  return PLUS_TAG.test(tag) && base === mailbox.trim().toLowerCase();
}

export interface StagingPrincipal {
  readonly tenantId: string;
  readonly userId: string;
}

export interface StagingAccess {
  readonly environment: EnvironmentClass;
  /** True only when public sign-up was explicitly enabled. Startup refuses that outside LOCAL/TEST. */
  readonly publicSignUp: boolean;
  /**
   * Explicit (tenant id, user id) pairs. Empty on STAGING admits nobody.
   * The demo account is not inserted when this list is empty or the flag is on.
   */
  readonly fixturePrincipals: readonly StagingFixturePrincipal[];
  /** R16.1 (proposal, not released): SUAS_PUBLIC_DEMO=enabled. Absent means off. */
  readonly publicDemo?: boolean;
  /** R16.2 (proposal, not released): the demo caps; read only while the demo is active. */
  readonly publicDemoLimits?: PublicDemoLimits;
}

export function stagingAccessFromConfig(config: SuasConfig): StagingAccess {
  return {
    environment: config.environment,
    publicSignUp: config.publicSignUp,
    publicDemo: config.publicDemo,
    publicDemoLimits: config.publicDemoLimits,
    fixturePrincipals: Object.freeze(
      config.stagingFixturePrincipals.map((principal) => Object.freeze({ ...principal })),
    ),
  };
}

/**
 * Is STAGING running the public demo (R16.1, contributor proposal, not released)? Only STAGING
 * changes: in LOCAL and TEST the flag affects nothing but the banner and the acknowledgement.
 */
export function publicDemoActive(access: StagingAccess | undefined): boolean {
  return access?.environment === 'STAGING' && access.publicDemo === true;
}

/**
 * The demo caps while the STAGING public demo is active, else undefined. A server always has
 * them (stagingAccessFromConfig); an active demo without them is a wiring fault and fails closed.
 */
export function activePublicDemoLimits(
  access: StagingAccess | undefined,
): PublicDemoLimits | undefined {
  if (!publicDemoActive(access)) return undefined;
  if (access?.publicDemoLimits === undefined) {
    throw new Error('STAGING public demo is on without its limits.');
  }
  return access.publicDemoLimits;
}

/**
 * Public self sign-up is permitted only in LOCAL and TEST, and on STAGING in public demo mode
 * (R16.1, contributor proposal, not released). A refusal is silent: the caller
 * treats the address like any unenrolled one (the same 202), so a refusal never reveals whether
 * an address is enrolled. Released basis: AUTH.md §9.3 at 0.7.0 ("Challenge issuance remains
 * non-enumerating"), and AUTH.md §9.4 with ENVIRONMENT.md §3 / D-052, released in 0.8.0 and
 * carried in the pinned 0.9.0. The predicate deliberately ignores `publicSignUp`: the opt-in
 * flag is owned by startup config, which refuses it outside LOCAL and TEST.
 */
export function publicSignUpPermitted(access: StagingAccess | undefined): boolean {
  if (publicDemoActive(access)) return true;
  return access !== undefined && (access.environment === 'LOCAL' || access.environment === 'TEST');
}

/**
 * True when STAGING must refuse this account. Other environment classes are
 * not gated here. Admission is the (tenant id, user id) pair. The same email
 * in another tenant, or the same tenant with a different user id, is refused.
 * An empty or missing registry admits nobody. Public demo mode (R16.1, proposal) admits all.
 */
export function stagingFixturePrincipalRefused(
  access: StagingAccess,
  principal: StagingPrincipal | undefined,
): boolean {
  if (access.publicDemo === true) return false;
  return vaConfirmationFixtureRefused(access, principal);
}

/**
 * The fixture gate for VA confirmation (the API confirm route and the VA sandbox OAuth routes).
 * R16.1 (contributor proposal, not released) / owner review on #363: public demo mode does not
 * lift it, so on STAGING only a registered fixture principal reaches the VA sandbox.
 */
export function vaConfirmationFixtureRefused(
  access: StagingAccess | undefined,
  principal: StagingPrincipal | undefined,
): boolean {
  if (access?.environment !== 'STAGING') return false;
  if (principal === undefined) return true;
  const tenantId = principal.tenantId.toLowerCase();
  const userId = principal.userId.toLowerCase();
  return !access.fixturePrincipals.some(
    (entry) => entry.tenantId === tenantId && entry.userId === userId,
  );
}
