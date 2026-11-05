/**
 * Authorization policy.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §1, §6 — authorization is role + tenant + row +
 *   consent/system basis; no one self-elevates to SUAS-admin.
 * - SUAS-specs SECURITY.md §2 — tenant isolation, row-level authorization, MFA for
 *   privileged roles.
 * - SUAS-specs SECURITY.md §5 — broken access control and cross-person leakage are
 *   named threats; deny by default.
 * - V1_PROJECT_PLAN.md §2.1 — no Organizations or Responders. The only global role is
 *   SUAS System Administrator. Everything else is a row check: the requester owns
 *   their Support Case and Service Requests, and the person who accepted a request
 *   acts on it. Those checks sit next to the data they guard (coordination module and
 *   routes), not in a role table.
 * - SUAS-specs API.md §4 — cross-tenant hidden resources return 404 or a scoped
 *   denial without existence leakage; missing consent returns 403 CONSENT_DENIED.
 *
 * Consent is the fourth input and lives in `src/consent`: role, tenant, and row
 * are evaluated here, while use-time consent evaluation is
 * `requireDisclosure()`. They are separate because a caller needs both — passing
 * a role check never implies a disclosure is consented.
 */

import { MfaRequiredError } from '../auth/mfa.js';
import type { AuthContext } from './context.js';

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  readonly httpStatus = 401;

  constructor(message = 'Authentication is required.') {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor(message = 'You do not have access to this action.') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Cross-tenant and cross-row denials surface as 404 so a caller cannot learn that
 * a resource exists in another tenant (API.md §4).
 */
export class ResourceNotVisibleError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'ResourceNotVisibleError';
  }
}

/** Deny unless the context is scoped to the tenant that owns the row. */
export function assertTenant(context: AuthContext, tenantId: string): void {
  if (context.tenantId !== tenantId) {
    throw new ResourceNotVisibleError();
  }
}

/** Deny unless the actor holds the global SUAS-admin grant. */
export function assertSuasAdmin(context: AuthContext): void {
  if (!context.isSuasAdmin) {
    throw new ForbiddenError('This action requires the SUAS System Administrator role.');
  }
}

/** Deny unless the session is MFA-elevated. AUTH.md §4; SECURITY.md §2. */
export function assertMfaElevated(context: AuthContext, action: string): void {
  if (!context.mfaElevated) {
    throw new MfaRequiredError(action);
  }
}

export interface AuthorizationRequirement {
  /** Tenant that owns the row being acted on. */
  readonly tenantId?: string;
  readonly requireSuasAdmin?: boolean;
  readonly requireMfaElevation?: boolean;
  /** Human-readable action name, used in denial messages. */
  readonly action?: string;
}

/**
 * Evaluate tenant + global role in one place. Deny by default: a requirement that
 * names no authority at all is refused rather than treated as public.
 */
export function authorize(context: AuthContext, requirement: AuthorizationRequirement): void {
  const action = requirement.action ?? 'This action';

  if (requirement.tenantId !== undefined) {
    assertTenant(context, requirement.tenantId);
  }

  if (requirement.requireSuasAdmin === true) {
    assertSuasAdmin(context);
  } else {
    throw new ForbiddenError(
      `${action} did not specify an authority to check; access is denied by default ` +
        `(SUAS-specs SECURITY.md §5).`,
    );
  }

  if (requirement.requireMfaElevation === true) {
    assertMfaElevated(context, action);
  }
}
