/**
 * Case queue, released case commands, resolve, and Settlement reads.
 *
 * Spec citations:
 * - SUAS-specs API.md §3 (`/cases`), §8 commands, §9 resolve/settlements
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 / §4
 * - SUAS-specs CASES.md §4 transition table, §5 claim/assign
 * - SUAS-specs SETTLEMENT.md §1–§6
 * - SUAS-specs API.md §4 / §7
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
  DEFAULT_PAGE_SIZE,
  executeCaseCommand,
  findActiveAssignment,
  findCase,
  MAX_PAGE_SIZE,
  readCaseQueue,
  type CaseCommand,
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

/**
 * Released CASES.md §4 commands that share `executeCaseCommand`.
 * CLAIM_CASE / ASSIGN_CASE / RESOLVE have dedicated handlers below.
 */
const EXECUTE_CASE_HTTP = [
  {
    kebab: 'triage',
    command: 'TRIAGE',
    auth: 'responder_or_admin',
    reasonRequired: false,
  },
  {
    kebab: 'activate',
    command: 'ACTIVATE',
    auth: 'assigned_responder',
    reasonRequired: false,
  },
  {
    kebab: 'move-to-followup',
    command: 'MOVE_TO_FOLLOWUP',
    auth: 'assigned_responder',
    reasonRequired: true,
  },
  {
    kebab: 'resume-active',
    command: 'RESUME_ACTIVE',
    auth: 'assigned_responder',
    reasonRequired: false,
  },
  {
    kebab: 'escalate',
    command: 'ESCALATE',
    auth: 'assigned_responder',
    reasonRequired: true,
  },
  {
    kebab: 'close',
    command: 'CLOSE',
    auth: 'assigned_or_admin',
    reasonRequired: false,
  },
  {
    kebab: 'reopen',
    command: 'REOPEN',
    auth: 'org_admin',
    reasonRequired: true,
  },
] as const satisfies ReadonlyArray<{
  kebab: string;
  command: Exclude<CaseCommand, 'CLAIM_CASE' | 'ASSIGN_CASE' | 'RESOLVE'>;
  auth: 'responder_or_admin' | 'assigned_responder' | 'assigned_or_admin' | 'org_admin';
  reasonRequired: boolean;
}>;

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
  // API.md §5: cursor + limit, default 20, maximum 100. The bounds come from the
  // queue module so the route cannot drift from the keyset reader it calls.
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
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

async function assertAssignedResponder(
  pool: Pool,
  caseId: string,
  userId: string,
  action: string,
): Promise<void> {
  const assignment = await findActiveAssignment(pool, caseId);
  if (assignment === undefined || assignment.responderUserId !== userId) {
    throw new ForbiddenError(
      `${action} requires the active assigned responder (SUAS-specs CASES.md §4).`,
    );
  }
}

function isOrgAdmin(context: AuthContext): boolean {
  return context.memberships.some((membership) => membership.role === 'ORG_ADMIN');
}

const optionalReasonBody = z.object({
  reason: z.string().min(1).max(2000).optional(),
  expected_status: z
    .enum(['OPEN', 'TRIAGED', 'ASSIGNED', 'ACTIVE', 'FOLLOWUP', 'RESOLVED', 'CLOSED'])
    .optional(),
});
const requiredReasonBody = z.object({
  reason: z.string().min(1).max(2000),
  expected_status: z
    .enum(['OPEN', 'TRIAGED', 'ASSIGNED', 'ACTIVE', 'FOLLOWUP', 'RESOLVED', 'CLOSED'])
    .optional(),
});

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
      { limit: query.limit, ...(query.cursor !== undefined ? { cursor: query.cursor } : {}) },
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

  for (const entry of EXECUTE_CASE_HTTP) {
    app.post(`${API_PREFIX}/cases/:id/commands/${entry.kebab}`, async (request) => {
      const context = await authenticate(deps.pool, deps.sessionSecret, request);
      const { id } = idParams.parse(request.params);
      const body = entry.reasonRequired
        ? requiredReasonBody.parse(request.body ?? {})
        : optionalReasonBody.parse(request.body ?? {});
      const existing = await findCase(deps.pool, context.tenantId, id);
      if (existing === undefined) throw new ResourceNotVisibleError();

      const admin = isOrgAdmin(context);
      if (entry.auth === 'org_admin') {
        assertOrgAdmin(context);
      } else if (entry.auth === 'responder_or_admin') {
        if (!admin) assertResponder(context);
      } else if (entry.auth === 'assigned_or_admin') {
        if (admin) {
          // org admin close path
        } else {
          assertResponder(context);
          await assertAssignedResponder(deps.pool, id, context.userId, entry.command);
        }
      } else {
        assertResponder(context);
        await assertAssignedResponder(deps.pool, id, context.userId, entry.command);
      }

      const actorType = admin && entry.auth !== 'assigned_responder' ? 'ORG_ADMIN' : 'RESPONDER';
      const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
      const fingerprint = fingerprintRequest({
        case_id: id,
        command: entry.command,
        reason: 'reason' in body && body.reason !== undefined ? body.reason : null,
        expected_status: body.expected_status ?? null,
        actor_id: context.userId,
      });
      const scope = commandScope({
        command: `POST /cases/{id}/commands/${entry.kebab}`,
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
          const supportCase = await executeCaseCommand(deps.pool, {
            tenantId: context.tenantId,
            caseId: id,
            command: entry.command,
            actorId: context.userId,
            actorType,
            correlationId: String(request.id),
            ...('reason' in body && body.reason !== undefined ? { reason: body.reason } : {}),
            ...(body.expected_status !== undefined ? { expectedStatus: body.expected_status } : {}),
          });
          return {
            result: publicCase(supportCase),
            aggregateType: 'SupportCase',
            aggregateId: id,
          };
        },
      );

      return { ...run.result, replayed: run.replayed };
    });
  }

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
    await assertAssignedResponder(deps.pool, id, context.userId, 'RESOLVE');

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
