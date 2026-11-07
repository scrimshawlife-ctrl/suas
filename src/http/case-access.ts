/**
 * Who may touch a Support Case or one of its Service Requests, as a per-relationship check.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1: no Organizations or Responders. The requester owns their
 *   Support Case and Service Requests, and the person who accepted a request acts on it.
 *   Accepting is per request (decided 2026-11-05).
 * - SUAS-specs SECURITY.md §2 / API.md §4: row-level authorization, with no
 *   existence leakage to anyone outside the relationship.
 *
 * Two levels. A Service Request is touched by its requester, and by the helper who
 * accepted it only while that request is in the case's current cycle
 * (`resolveRequestAccess`). Closing the case, or reopening it, ends that helper's
 * standing. A case-level action (contact log, follow-ups, case commands, resolve) uses
 * the same cycle (`resolveCaseAccess`). Anyone else gets a 404, the same as a case
 * that does not exist; there is no tenant-wide role that reads other people's cases.
 */

import type { Queryable } from '../db/index.js';
import { ForbiddenError, ResourceNotVisibleError, type AuthContext } from '../authz/index.js';
import {
  findCase,
  holdsRequestInCase,
  requestHeldInCurrentCycle,
  type ServiceRequest,
  type SupportCase,
} from '../coordination/index.js';

export interface CaseAccess {
  readonly supportCase: SupportCase;
  /** The caller is the person who asked for help. */
  readonly owner: boolean;
  /** The caller holds at least one request of this case: they accepted it. */
  readonly accepter: boolean;
}

/** Resolve the caller's relationship to a case, or 404 when they have none. */
export async function resolveCaseAccess(
  db: Queryable,
  context: AuthContext,
  caseId: string,
): Promise<CaseAccess> {
  const supportCase = await findCase(db, context.tenantId, caseId);
  if (supportCase === undefined) throw new ResourceNotVisibleError();
  const owner = supportCase.veteranUserId === context.userId;
  const accepter =
    !owner && (await holdsRequestInCase(db, context.tenantId, caseId, context.userId));
  if (!owner && !accepter) throw new ResourceNotVisibleError();
  return { supportCase, owner, accepter };
}

/** Deny unless the caller holds a request of the case. */
export function assertAccepter(access: CaseAccess, action: string): void {
  if (!access.accepter) {
    throw new ForbiddenError(`${action} is reserved for a person who accepted a request here.`);
  }
}

export interface RequestAccess {
  readonly supportCase: SupportCase;
  /** The caller is the person who asked for help. */
  readonly owner: boolean;
  /** The caller accepted this very request. */
  readonly holder: boolean;
}

/** Resolve the caller's relationship to one Service Request, or 404 when they have none. */
export async function resolveRequestAccess(
  db: Queryable,
  context: AuthContext,
  serviceRequest: ServiceRequest,
): Promise<RequestAccess> {
  const supportCase = await findCase(db, context.tenantId, serviceRequest.caseId);
  if (supportCase === undefined) throw new ResourceNotVisibleError();
  const owner = supportCase.veteranUserId === context.userId;
  const holder =
    !owner &&
    (await requestHeldInCurrentCycle(
      db,
      context.tenantId,
      serviceRequest.serviceRequestId,
      context.userId,
    ));
  if (!owner && !holder) throw new ResourceNotVisibleError();
  return { supportCase, owner, holder };
}
