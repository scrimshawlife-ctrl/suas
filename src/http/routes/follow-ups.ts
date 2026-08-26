/**
 * Follow-Up create / list / complete over `/api/v0`.
 *
 * Spec citations:
 * - SUAS-specs APIS.md follow-up rows; FOLLOWUP.md §1 / §3 / §6
 * - SUAS-specs API.md §4 / §7
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import { assertResponder, ResourceNotVisibleError } from '../../authz/index.js';
import { findCase } from '../../coordination/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';
import {
  completeFollowUpInTx,
  createFollowUpInTx,
  findFollowUp,
  listOpenFollowUps,
  RESOLUTION_DISPOSITIONS,
  RESPONSIBLE_TYPES,
  type FollowUp,
} from '../../settlement/index.js';

export interface FollowUpRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const caseIdParams = z.object({ caseId: z.string().uuid() });

const createBody = z.object({
  case_id: z.string().uuid(),
  due_at: z.string().datetime(),
  responsible_type: z.enum(RESPONSIBLE_TYPES),
  responsible_id: z.string().uuid(),
  service_request_id: z.string().uuid().optional(),
  resolution_disposition: z.enum(RESOLUTION_DISPOSITIONS).optional(),
});

function publicFollowUp(followUp: FollowUp) {
  return {
    follow_up_id: followUp.followUpId,
    case_id: followUp.caseId,
    service_request_id: followUp.serviceRequestId ?? null,
    due_at: followUp.dueAt.toISOString(),
    schedule_version: followUp.scheduleVersion,
    responsible_type: followUp.responsibleType,
    responsible_id: followUp.responsibleId,
    status: followUp.status,
    coordination_attempt_count: followUp.coordinationAttemptCount,
    resolution_disposition: followUp.resolutionDisposition ?? null,
  };
}

async function assertCaseAccess(pool: Pool, tenantId: string, userId: string, caseId: string) {
  const supportCase = await findCase(pool, tenantId, caseId);
  if (supportCase === undefined) throw new ResourceNotVisibleError();
  const owner = supportCase.veteranUserId === userId;
  return { supportCase, owner };
}

export function registerFollowUpRoutes(app: FastifyInstance, deps: FollowUpRouteDeps): void {
  app.get(`${API_PREFIX}/cases/:caseId/follow-ups`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    const { owner } = await assertCaseAccess(deps.pool, context.tenantId, context.userId, caseId);
    if (!owner) assertResponder(context);
    const open = await listOpenFollowUps(deps.pool, context.tenantId, caseId);
    return { follow_ups: open.map(publicFollowUp) };
  });

  app.post(`${API_PREFIX}/follow-ups`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const body = createBody.parse(request.body);
    await assertCaseAccess(deps.pool, context.tenantId, context.userId, body.case_id);
    // Responder already asserted; case must exist in tenant (assertCaseAccess).
    const supportCase = await findCase(deps.pool, context.tenantId, body.case_id);
    if (supportCase === undefined) throw new ResourceNotVisibleError();

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      case_id: body.case_id,
      due_at: body.due_at,
      responsible_type: body.responsible_type,
      responsible_id: body.responsible_id,
      service_request_id: body.service_request_id ?? null,
      resolution_disposition: body.resolution_disposition ?? null,
    });
    const scope = commandScope({
      command: 'POST /follow-ups',
      aggregateType: 'SupportCase',
      aggregateId: body.case_id,
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
        const created = await createFollowUpInTx(tx, {
          tenantId: context.tenantId,
          caseId: body.case_id,
          dueAt: new Date(body.due_at),
          responsibleType: body.responsible_type,
          responsibleId: body.responsible_id,
          actorId: context.userId,
          actorType: 'RESPONDER',
          ...(body.service_request_id !== undefined
            ? { serviceRequestId: body.service_request_id }
            : {}),
          ...(body.resolution_disposition !== undefined
            ? { resolutionDisposition: body.resolution_disposition }
            : {}),
          correlationId: String(request.id),
        });
        return {
          result: publicFollowUp(created),
          aggregateType: 'FollowUp',
          aggregateId: created.followUpId,
        };
      },
    );

    if (!run.replayed) {
      return reply.status(201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: true };
  });

  app.post(`${API_PREFIX}/follow-ups/:id/commands/complete`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const followUp = await findFollowUp(deps.pool, context.tenantId, id);
    if (followUp === undefined) throw new ResourceNotVisibleError();
    const { owner } = await assertCaseAccess(
      deps.pool,
      context.tenantId,
      context.userId,
      followUp.caseId,
    );
    if (!owner) assertResponder(context);
    const actorType = owner ? 'VETERAN' : 'RESPONDER';
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      follow_up_id: id,
      command: 'complete',
      actor_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /follow-ups/{id}/commands/complete',
      aggregateType: 'FollowUp',
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
      async (tx) => {
        const completed = await completeFollowUpInTx(tx, {
          tenantId: context.tenantId,
          followUpId: id,
          actorId: context.userId,
          actorType,
          correlationId: String(request.id),
        });
        return {
          result: {
            ...publicFollowUp(completed.followUp),
            already_completed: completed.alreadyCompleted,
          },
          aggregateType: 'FollowUp',
          aggregateId: id,
        };
      },
    );

    return { ...run.result, replayed: run.replayed };
  });
}
