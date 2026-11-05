/**
 * Authorization context.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §1 — "Authentication is not authorization. Authorization
 *   remains role + tenant + row + consent/system basis."
 * - SUAS-specs AUTH.md §5 — in-flight authorization after revocation re-evaluates
 *   authoritative user/session state rather than trusting stale client claims.
 * - V1_PROJECT_PLAN.md §2.1 — no Organizations or Responders. A person owns what
 *   they requested, acts on what they accepted, and SUAS System Administrators act
 *   through admin grants. Those row checks live in the routes and domain modules.
 * - SUAS-specs API.md §4 — the server derives tenant and actor authority; clients
 *   cannot choose an arbitrary tenant scope.
 *
 * The context is rebuilt from the database per request. Nothing here is taken
 * from a client-supplied claim.
 */

import type { Pool } from 'pg';
import { isSuasAdmin } from '../identity/admins.js';
import {
  isElevated,
  resolveSession,
  type Session,
  type SessionRejection,
} from '../auth/session.js';

export interface AuthContext {
  readonly session: Session;
  /** Server-derived tenant scope. Never read from the request body or query. */
  readonly tenantId: string;
  readonly userId: string;
  readonly isSuasAdmin: boolean;
  /** MFA elevation, evaluated against the elevation TTL at resolution time. */
  readonly mfaElevated: boolean;
}

export type AuthResolution =
  | { readonly ok: true; readonly context: AuthContext }
  | { readonly ok: false; readonly reason: SessionRejection };

/**
 * Resolve a credential into a full authorization context.
 *
 * Session validity, user status, and the global admin grant are all
 * read now — not cached from issue time — so a revoke observed on one instance is
 * enforced on every other.
 */
export async function resolveAuthContext(
  pool: Pool,
  sessionSecret: string | undefined,
  credential: string,
): Promise<AuthResolution> {
  const resolved = await resolveSession(pool, sessionSecret, credential);
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason };
  }

  const admin = await isSuasAdmin(pool, resolved.session.userId);

  return {
    ok: true,
    context: {
      session: resolved.session,
      tenantId: resolved.session.tenantId,
      userId: resolved.session.userId,
      isSuasAdmin: admin,
      mfaElevated: isElevated(resolved.session),
    },
  };
}
