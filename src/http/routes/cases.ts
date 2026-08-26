/**
 * Case queue and claim.
 *
 * Spec citations:
 * - SUAS-specs API.md §3 (`/cases`), §8 claim command
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (`CLAIM_CASE`), §4 (unassigned vs mine)
 * - SUAS-specs CASES.md §5 (one contender wins; loser writes nothing)
 * - SUAS-specs API.md §4 (tenant is server-derived)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import {
  assertResponder,
  ForbiddenError,
  ResourceNotVisibleError,
  type AuthContext,
} from '../../authz/index.js';
import {
  assignCase,
  claimCase,
  findCase,
  readCaseQueue,
  type SupportCase,
} from '../../coordination/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface CaseRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  ownership: z.enum(['unassigned', 'mine']).default('unassigned'),
});
const assignBody = z.object({
  responder_user_id: z.string().uuid(),
});

function publicCase(supportCase: SupportCase) {
  return {
    case_id: supportCase.caseId,
    status: supportCase.status,
    priority_signal_level: supportCase.prioritySignalLevel ?? null,
  };
}

function assertOrgAdmin(context: AuthContext): void {
  if (!context.memberships.some((membership) => membership.role === 'ORG_ADMIN')) {
    throw new ForbiddenError('This action requires an active organization admin membership.');
  }
}

export function registerCaseRoutes(app: FastifyInstance, deps: CaseRouteDeps): void {
  app.get(`${API_PREFIX}/cases`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const query = listQuery.parse(request.query);
    const page = await readCaseQueue(
      deps.pool,
      context.tenantId,
      query.ownership === 'mine'
        ? { ownership: 'mine', responderUserId: context.userId }
        : { ownership: 'unassigned' },
      { limit: 20 },
    );
    return {
      cases: page.cases.map(publicCase),
      next_cursor: page.nextCursor ?? null,
    };
  });

  app.get(`${API_PREFIX}/cases/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const supportCase = await findCase(deps.pool, context.tenantId, id);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const owner = supportCase.veteranUserId === context.userId;
    if (!owner) assertResponder(context);
    return publicCase(supportCase);
  });

  app.post(`${API_PREFIX}/cases/:id/commands/claim`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const { id } = idParams.parse(request.params);
    const existing = await findCase(deps.pool, context.tenantId, id);
    if (existing === undefined) throw new ResourceNotVisibleError();
    const result = await claimCase(deps.pool, {
      tenantId: context.tenantId,
      caseId: id,
      responderUserId: context.userId,
      correlationId: String(request.id),
    });
    return {
      ...publicCase(result.supportCase),
      assignment_id: result.assignment.caseAssignmentId,
    };
  });

  /**
   * CASES.md §5.7 `ASSIGN_CASE` — org-admin first assignment or reassignment.
   * Distinct from responder `CLAIM_CASE`.
   */
  app.post(`${API_PREFIX}/cases/:id/commands/assign`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertOrgAdmin(context);
    const { id } = idParams.parse(request.params);
    const body = assignBody.parse(request.body);
    const existing = await findCase(deps.pool, context.tenantId, id);
    if (existing === undefined) throw new ResourceNotVisibleError();

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      case_id: id,
      responder_user_id: body.responder_user_id,
      command: 'ASSIGN_CASE',
      actor_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /cases/{id}/commands/assign',
      aggregateType: 'SupportCase',
      aggregateId: id,
      actorId: context.userId,
    });

    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: scope,
        idempotencyKey,
        requestFingerprint: fingerprint,
      },
      async () => {
        const result = await assignCase(deps.pool, {
          tenantId: context.tenantId,
          caseId: id,
          responderUserId: body.responder_user_id,
          assignedBy: context.userId,
          correlationId: String(request.id),
        });
        return {
          result: {
            ...publicCase(result.supportCase),
            assignment_id: result.assignment.caseAssignmentId,
            responder_user_id: result.assignment.responderUserId,
          },
          aggregateType: 'SupportCase',
          aggregateId: id,
        };
      },
    );

    return { ...run.result, replayed: run.replayed };
  });
}
