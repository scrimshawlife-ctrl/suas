/**
 * Support Case create, accept, case commands, resolve, and Settlement reads.
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
import { assertSuasAdmin, ResourceNotVisibleError } from '../../authz/index.js';
import {
  executeCaseCommand,
  findCase,
  openCase,
  type CaseCommand,
  type SupportCase,
} from '../../coordination/index.js';
import { assertAccepter, resolveCaseAccess } from '../case-access.js';
import { findUserById, requireCounty, requireVerifiedVeteran } from '../../identity/index.js';
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
 * CASES.md §4 commands that share `executeCaseCommand`. `accept` and `resolve` have
 * dedicated handlers. `triage` and `reopen` are staff actions (SUAS System
 * Administrators); the rest belong to the person who accepted the case.
 */
const EXECUTE_CASE_HTTP = [
  { kebab: 'triage', command: 'TRIAGE', auth: 'suas_admin', reasonRequired: false },
  { kebab: 'activate', command: 'ACTIVATE', auth: 'accepter', reasonRequired: false },
  {
    kebab: 'move-to-followup',
    command: 'MOVE_TO_FOLLOWUP',
    auth: 'accepter',
    reasonRequired: true,
  },
  { kebab: 'resume-active', command: 'RESUME_ACTIVE', auth: 'accepter', reasonRequired: false },
  { kebab: 'escalate', command: 'ESCALATE', auth: 'accepter', reasonRequired: true },
  { kebab: 'close', command: 'CLOSE', auth: 'accepter_or_suas_admin', reasonRequired: false },
  { kebab: 'reopen', command: 'REOPEN', auth: 'suas_admin', reasonRequired: true },
] as const satisfies ReadonlyArray<{
  kebab: string;
  command: Exclude<CaseCommand, 'CLAIM_CASE' | 'RESOLVE'>;
  auth: 'suas_admin' | 'accepter' | 'accepter_or_suas_admin';
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
const resolveBody = z.object({
  requested: z.record(z.unknown()),
  occurred: z.record(z.unknown()),
  fulfilled: z.record(z.unknown()),
  unresolved: z.record(z.unknown()),
  // The author, the accepter and the requester's confirmation are derived on the server.
  // A client that still sends authored_by, accepted_by_user_id or veteran_confirmed_by
  // has them dropped by this schema (zod strips unknown keys, as everywhere in this API).
  expected_status: z.enum(['ACTIVE', 'FOLLOWUP']).optional(),
});

/**
 * RED never goes to peers (V1_PROJECT_PLAN.md §2.1): only the case owner and a SUAS admin get
 * the real level; an accepter always sees null.
 */
function publicCase(supportCase: SupportCase, revealPriority: boolean) {
  return {
    case_id: supportCase.caseId,
    status: supportCase.status,
    priority_signal_level: revealPriority ? (supportCase.prioritySignalLevel ?? null) : null,
  };
}

export function publicSettlement(settlement: Settlement) {
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
    accepted_by_user_id: settlement.acceptedByUserId,
    veteran_confirmed_by: settlement.veteranConfirmedBy ?? null,
    settled_at: settlement.settledAt.toISOString(),
  };
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
  app.post(`${API_PREFIX}/cases`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const veteran = await findUserById(deps.pool, context.tenantId, context.userId);
    if (veteran === undefined) throw new ResourceNotVisibleError();
    await requireVerifiedVeteran(deps.pool, context);
    await requireCounty(deps.pool, context);

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({ actor_id: context.userId });
    const scope = commandScope({
      command: 'POST /cases',
      aggregateType: 'SupportCase',
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
      async (tx) => {
        const opened = await openCase(tx, {
          tenantId: context.tenantId,
          veteranUserId: context.userId,
          actorType: 'VETERAN',
          actorId: context.userId,
          correlationId: String(request.id),
        });
        return {
          result: { ...publicCase(opened.supportCase, true), created: opened.created },
          aggregateType: 'SupportCase',
          aggregateId: opened.supportCase.caseId,
        };
      },
    );

    if (!run.replayed && run.result.created) {
      return reply.status(201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: run.replayed };
  });

  app.get(`${API_PREFIX}/cases/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const { supportCase, owner } = await resolveCaseAccess(deps.pool, context, id);
    return publicCase(supportCase, owner);
  });

  for (const entry of EXECUTE_CASE_HTTP) {
    app.post(`${API_PREFIX}/cases/:id/commands/${entry.kebab}`, async (request) => {
      const context = await authenticate(deps.pool, deps.sessionSecret, request);
      const { id } = idParams.parse(request.params);
      const body = entry.reasonRequired
        ? requiredReasonBody.parse(request.body ?? {})
        : optionalReasonBody.parse(request.body ?? {});
      let actorType: 'USER' | 'SUAS_ADMIN';
      if (entry.auth === 'suas_admin') {
        assertSuasAdmin(context);
        actorType = 'SUAS_ADMIN';
      } else if (entry.auth === 'accepter_or_suas_admin' && context.isSuasAdmin) {
        actorType = 'SUAS_ADMIN';
      } else {
        assertAccepter(await resolveCaseAccess(deps.pool, context, id), entry.command);
        actorType = 'USER';
      }
      // An admin acts across people, so confirm the case exists in the tenant.
      if (actorType === 'SUAS_ADMIN') {
        const existing = await findCase(deps.pool, context.tenantId, id);
        if (existing === undefined) throw new ResourceNotVisibleError();
      }

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
            result: publicCase(supportCase, actorType === 'SUAS_ADMIN'),
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
    const { id } = idParams.parse(request.params);
    const body = resolveBody.parse(request.body ?? {});
    assertAccepter(await resolveCaseAccess(deps.pool, context, id), 'RESOLVE');

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    // SETTLEMENT.md §2: the accountable author is the person resolving, and the accepter
    // is that same person: only a helper who holds a request of the case may resolve it.
    const acceptedByUserId = context.userId;
    const content = {
      requested: body.requested as JsonObject,
      occurred: body.occurred as JsonObject,
      fulfilled: body.fulfilled as JsonObject,
      unresolved: body.unresolved as JsonObject,
      authoredBy: context.userId,
      acceptedByUserId,
    };

    const result = await resolveCaseWithSettlement(deps.pool, {
      tenantId: context.tenantId,
      caseId: id,
      actorId: context.userId,
      content,
      idempotencyKey,
      deriveRequesterConfirmation: true,
      correlationId: String(request.id),
      ...(body.expected_status !== undefined ? { expectedStatus: body.expected_status } : {}),
    });

    return {
      ...publicCase(result.supportCase, false),
      settlement_id: result.settlement.settlementId,
      resolution_cycle: result.settlement.resolutionCycle,
      settlement: publicSettlement(result.settlement),
      replayed: result.replayed,
    };
  });

  app.get(`${API_PREFIX}/cases/:id/settlements`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const { owner } = await resolveCaseAccess(deps.pool, context, id);

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
    const { owner } = await resolveCaseAccess(deps.pool, context, id);

    const settlement = await findSettlement(deps.pool, context.tenantId, settlementId);
    if (settlement === undefined || settlement.caseId !== id) {
      throw new ResourceNotVisibleError();
    }
    return owner ? veteranVisibleSettlement(settlement) : publicSettlement(settlement);
  });
}
