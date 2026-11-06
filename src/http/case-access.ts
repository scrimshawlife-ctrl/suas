/**
 * Who may touch a Support Case, as a per-relationship check.
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1: no Organizations or Responders. The requester owns their
 *   Support Case and Service Requests, and the person who accepted acts on them.
 * - SUAS-specs SECURITY.md §2 / API.md §4: row-level authorization, with no
 *   existence leakage to anyone outside the relationship.
 *
 * A person who is neither the requester nor the current accepter gets a 404, the same
 * as a case that does not exist. The requester and the accepter are the only
 * relationships; there is no tenant-wide role that reads other people's cases.
 */

import type { Queryable } from '../db/index.js';
import { ForbiddenError, ResourceNotVisibleError, type AuthContext } from '../authz/index.js';
import {
  findActiveAssignment,
  findCase,
  type CaseAssignment,
  type SupportCase,
} from '../coordination/index.js';

export interface CaseAccess {
  readonly supportCase: SupportCase;
  /** The caller is the person who asked for help. */
  readonly owner: boolean;
  /** The caller holds the active assignment: they accepted this case. */
  readonly accepter: boolean;
  readonly assignment: CaseAssignment | undefined;
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
  const assignment = await findActiveAssignment(db, caseId);
  const accepter = assignment?.acceptedByUserId === context.userId;
  if (!owner && !accepter) throw new ResourceNotVisibleError();
  return { supportCase, owner, accepter, assignment };
}

/** Deny unless the caller is the person who accepted the case. */
export function assertAccepter(access: CaseAccess, action: string): void {
  if (!access.accepter) {
    throw new ForbiddenError(`${action} is reserved for the person who accepted this case.`);
  }
}
