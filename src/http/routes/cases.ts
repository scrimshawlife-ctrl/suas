/**
 * Case queue, claim, assign, resolve, and Settlement reads.
 *
 * Spec citations:
 * - SUAS-specs API.md §3 (`/cases`), §8 claim command, §9 resolve/settlements
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (`CLAIM_CASE`), §4 (unassigned vs mine)
 * - SUAS-specs CASES.md §5 (one contender wins; loser writes nothing), §4 RESOLVE
 * - SUAS-specs SETTLEMENT.md §1–§6 (content, cycles, veteran visibility)
 * - SUAS-specs API.md §4 (tenant is server-derived), §7 (Idempotency-Key)
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
  findActiveAssignment,
  findCase,
  readCaseQueue,
  type SupportCase,
} from '../../coordination/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import type { JsonObject } from '../../jobs/index.js';
import { API_PREFIX } from '../../release/pins.js';
import {
  findSettlement,
  listSettlements,
  resolveCaseWithSettlement,
  veteranVisibleSettlement,
  type Settlement,
} from '../../settlement/index.js';

export interface CaseRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const settlementParams = z.object({
  id: z.string().uuid(),
  settlement_id: z.string().uuid(),
});
const listQuery = z.object({
  ownership: z.enum(['unassigned', 'mine']).default('unassigned'),
});
const assignBody = z.object({
  responder_user_id: z.string().uuid(),
});
const resolveBody = z.object({
  requested: z.record(z.unknown()),
  occurred: z.record(z.unknown()),
  fulfilled: z.record(z.unknown()),
  unresolved: z.record(z.unknown()),
  authored_by: z.string().uuid(),
  responder_confirmed_by: z.string().uuid(),
  veteran_confirmed_by: z.string().uuid().optional(),
  expected_status: z.enum(['ACTIVE', 'FOLLOWUP']).optional(),
});

function publicCase(supportCase: SupportCase) {
  return {
    case_id: supportCase.caseId,
    status: supportCase.status,
    priority_signal_level: supportCase.prioritySignalLevel ?? null,
  };
}

function publicSettlement(settlement: Settlement) {
  return {
    settlement_id: settlement.settlementId,
    case_id: settlement.caseId,
    resolution_cycle: settlement.resolutionCycle,
    requested: settlement.requestedSummary,
    occurred: settlement.occurredSummary,
    fulfilled: settlement.fulfilledSummary,
    unresolved: settlement.unresolvedSummary,
    remaining_follow_ups: settlement.remainingFollowUps,
    authored_by: settlement.authoredBy,
    responder_confirmed_by: settlement.responderConfirmedBy,
    veteran_confirmed_by: settlement.veteranConfirmedBy ?? null,
    settled_at: settlement.settledAt.toISOString(),
  };
}

function assertOrgAdmin(context: AuthContext): void {
  if (!context.memberships.some((membership) => membership.role === 'ORG_ADMIN')) {
    throw new ForbiddenError('This action requires an active organization admin membership.');
  }
}

async function assertAssignedResponder(pool: Pool, caseId: string, userId: string): Promise<void> {
  const assignment = await findActiveAssignment(pool, caseId);
  if (assignment === undefined || assignment.responderUserId !== userId) {
    throw new ForbiddenError(
      'RESOLVE requires the active assigned responder (SUAS-specs CASES.md §4).',
    );
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

  /**
   * API.md §9 / SETTLEMENT.md — resolve creates Settlement + CASE_RESOLVED.
   * Domain `resolveCaseWithSettlement` owns the idempotency record when a key
   * is supplied (command scope `POST /cases/{id}/commands/resolve`).
   */
  app.post(`${API_PREFIX}/cases/:id/commands/resolve`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const { id } = idParams.parse(request.params);
    const body = resolveBody.parse(request.body ?? {});
    const existing = await findCase(deps.pool, context.tenantId, id);
    if (existing === undefined) throw new ResourceNotVisibleError();
    await assertAssignedResponder(deps.pool, id, context.userId);

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const content = {
      requested: body.requested as JsonObject,
      occurred: body.occurred as JsonObject,
      fulfilled: body.fulfilled as JsonObject,
      unresolved: body.unresolved as JsonObject,
      authoredBy: body.authored_by,
      responderConfirmedBy: body.responder_confirmed_by,
      ...(body.veteran_confirmed_by !== undefined
        ? { veteranConfirmedBy: body.veteran_confirmed_by }
        : {}),
    };

    const result = await resolveCaseWithSettlement(deps.pool, {
      tenantId: context.tenantId,
      caseId: id,
      actorId: context.userId,
      content,
      idempotencyKey,
      correlationId: String(request.id),
      ...(body.expected_status !== undefined ? { expectedStatus: body.expected_status } : {}),
    });

    return {
      ...publicCase(result.supportCase),
      settlement_id: result.settlement.settlementId,
      resolution_cycle: result.settlement.resolutionCycle,
      settlement: publicSettlement(result.settlement),
      replayed: result.replayed,
    };
  });

  app.get(`${API_PREFIX}/cases/:id/settlements`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const supportCase = await findCase(deps.pool, context.tenantId, id);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const owner = supportCase.veteranUserId === context.userId;
    if (!owner) assertResponder(context);

    const settlements = await listSettlements(deps.pool, context.tenantId, id);
    return {
      settlements: owner
        ? settlements.map(veteranVisibleSettlement)
        : settlements.map(publicSettlement),
    };
  });

  app.get(`${API_PREFIX}/cases/:id/settlements/:settlement_id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id, settlement_id: settlementId } = settlementParams.parse(request.params);
    const supportCase = await findCase(deps.pool, context.tenantId, id);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const owner = supportCase.veteranUserId === context.userId;
    if (!owner) assertResponder(context);

    const settlement = await findSettlement(deps.pool, context.tenantId, settlementId);
    if (settlement === undefined || settlement.caseId !== id) {
      throw new ResourceNotVisibleError();
    }
    return owner ? veteranVisibleSettlement(settlement) : publicSettlement(settlement);
  });
}
