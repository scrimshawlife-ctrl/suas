/**
 * Responder contact-log commands over `/api/v0`.
 *
 * Spec citations:
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 / §7
 * - SUAS-specs EVENT_MODEL.md §3.3 (`RESPONDER_CONTACT_LOGGED`)
 * - SUAS-specs API.md §4 / §7
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import { assertResponder, ResourceNotVisibleError } from '../../authz/index.js';
import {
  CONTACT_CHANNELS,
  CONTACT_OUTCOMES,
  findCase,
  listContactAttempts,
  recordContact,
  type ContactAttempt,
} from '../../coordination/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface ContactLogRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const caseIdParams = z.object({ caseId: z.string().uuid() });

const attemptBody = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  outcome: z.enum(['PENDING'] as const).default('PENDING'),
  note: z.string().min(1).max(2000).optional(),
  attempted_at: z.string().datetime().optional(),
});

const settledOutcomes = CONTACT_OUTCOMES.filter((value) => value !== 'PENDING') as [
  Exclude<(typeof CONTACT_OUTCOMES)[number], 'PENDING'>,
  ...Exclude<(typeof CONTACT_OUTCOMES)[number], 'PENDING'>[],
];

const completeBody = z.object({
  channel: z.enum(CONTACT_CHANNELS),
  outcome: z.enum(settledOutcomes),
  note: z.string().min(1).max(2000).optional(),
  attempted_at: z.string().datetime().optional(),
});

function publicContactAttempt(attempt: ContactAttempt) {
  return {
    contact_attempt_id: attempt.contactAttemptId,
    case_id: attempt.caseId,
    responder_user_id: attempt.responderUserId,
    attempted_at: attempt.attemptedAt.toISOString(),
    channel: attempt.channel,
    outcome: attempt.outcome,
  };
}

export function registerContactLogRoutes(app: FastifyInstance, deps: ContactLogRouteDeps): void {
  app.get(`${API_PREFIX}/cases/:caseId/contact-attempts`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const { caseId } = caseIdParams.parse(request.params);
    const supportCase = await findCase(deps.pool, context.tenantId, caseId);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const attempts = await listContactAttempts(deps.pool, context.tenantId, caseId);
    return { contact_attempts: attempts.map(publicContactAttempt) };
  });

  app.post(`${API_PREFIX}/cases/:caseId/commands/log-contact-attempt`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const { caseId } = caseIdParams.parse(request.params);
    const body = attemptBody.parse(request.body ?? {});
    const supportCase = await findCase(deps.pool, context.tenantId, caseId);
    if (supportCase === undefined) throw new ResourceNotVisibleError();

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      case_id: caseId,
      command: 'log-contact-attempt',
      channel: body.channel,
      outcome: body.outcome,
      note: body.note ?? null,
      attempted_at: body.attempted_at ?? null,
      actor_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /cases/{caseId}/commands/log-contact-attempt',
      aggregateType: 'SupportCase',
      aggregateId: caseId,
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
        // recordContact opens its own transaction and dedupes on the Domain
        // Event idempotency key; pass the HTTP key through.
        const recorded = await recordContact(deps.pool, {
          tenantId: context.tenantId,
          caseId,
          responderUserId: context.userId,
          command: 'log-contact-attempt',
          channel: body.channel,
          outcome: body.outcome,
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.attempted_at !== undefined ? { attemptedAt: new Date(body.attempted_at) } : {}),
          idempotencyKey,
          correlationId: String(request.id),
        });
        return {
          result: {
            ...publicContactAttempt(recorded.contactAttempt),
            deduplicated: recorded.deduplicated,
          },
          aggregateType: 'SupportCase',
          aggregateId: caseId,
        };
      },
    );

    if (!run.replayed && run.result.deduplicated !== true) {
      return reply.status(201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: run.replayed || run.result.deduplicated === true };
  });

  app.post(`${API_PREFIX}/cases/:caseId/commands/complete-contact`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertResponder(context);
    const { caseId } = caseIdParams.parse(request.params);
    const body = completeBody.parse(request.body);
    const supportCase = await findCase(deps.pool, context.tenantId, caseId);
    if (supportCase === undefined) throw new ResourceNotVisibleError();

    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      case_id: caseId,
      command: 'complete-contact',
      channel: body.channel,
      outcome: body.outcome,
      note: body.note ?? null,
      attempted_at: body.attempted_at ?? null,
      actor_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /cases/{caseId}/commands/complete-contact',
      aggregateType: 'SupportCase',
      aggregateId: caseId,
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
        const recorded = await recordContact(deps.pool, {
          tenantId: context.tenantId,
          caseId,
          responderUserId: context.userId,
          command: 'complete-contact',
          channel: body.channel,
          outcome: body.outcome,
          ...(body.note !== undefined ? { note: body.note } : {}),
          ...(body.attempted_at !== undefined ? { attemptedAt: new Date(body.attempted_at) } : {}),
          idempotencyKey,
          correlationId: String(request.id),
        });
        return {
          result: {
            ...publicContactAttempt(recorded.contactAttempt),
            deduplicated: recorded.deduplicated,
          },
          aggregateType: 'SupportCase',
          aggregateId: caseId,
        };
      },
    );

    if (!run.replayed && run.result.deduplicated !== true) {
      return reply.status(201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: run.replayed || run.result.deduplicated === true };
  });
}
