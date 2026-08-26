/**
 * Service Request reads and released write commands over `/api/v0`.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.3 / DISPATCH.md §1 / §3 / §4 / §8
 * - SUAS-specs API.md §4 / §7; CASES.md; RESPONDER_WORKFLOWS.md
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import { assertResponder, ResourceNotVisibleError } from '../../authz/index.js';
import type { AuthContext } from '../../authz/index.js';
import { requireDisclosure } from '../../consent/index.js';
import {
  createServiceRequest,
  executeServiceRequestCommandInTx,
  findCase,
  findServiceRequest,
  listCaseServiceRequests,
  SERVICE_CATEGORIES,
  SERVICE_REQUEST_COMMANDS,
  type ServiceRequest,
  type ServiceRequestCommand,
} from '../../coordination/index.js';
import type { JsonObject } from '../../jobs/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface ServiceRequestRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const caseIdParams = z.object({ caseId: z.string().uuid() });
const commandParams = z.object({
  id: z.string().uuid(),
  command: z.enum(SERVICE_REQUEST_COMMANDS),
});

const createBody = z.object({
  category: z.enum(SERVICE_CATEGORIES),
  details: z.record(z.unknown()).optional(),
});

const commandBody = z.object({
  reason: z.string().min(1).max(512).optional(),
  to: z.string().min(1).max(64).optional(),
  expected_status: z.string().min(1).max(64).optional(),
  grantee_id: z.string().uuid().optional(),
});

/** Commands a case veteran may issue without responder membership. */
const VETERAN_COMMANDS: readonly ServiceRequestCommand[] = ['SUBMIT', 'CANCEL', 'CONFIRM'];

function publicServiceRequest(request: ServiceRequest) {
  return {
    service_request_id: request.serviceRequestId,
    case_id: request.caseId,
    category: request.category,
    status: request.status,
  };
}

async function assertCaseAccess(
  pool: Pool,
  context: AuthContext,
  caseId: string,
): Promise<{ owner: boolean }> {
  const supportCase = await findCase(pool, context.tenantId, caseId);
  if (supportCase === undefined) throw new ResourceNotVisibleError();
  const owner = supportCase.veteranUserId === context.userId;
  if (!owner) assertResponder(context);
  return { owner };
}

function actorTypeFor(context: AuthContext, owner: boolean): 'VETERAN' | 'RESPONDER' {
  if (owner) return 'VETERAN';
  assertResponder(context);
  return 'RESPONDER';
}

export function registerServiceRequestRoutes(
  app: FastifyInstance,
  deps: ServiceRequestRouteDeps,
): void {
  app.get(`${API_PREFIX}/cases/:caseId/service-requests`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    await assertCaseAccess(deps.pool, context, caseId);
    const page = await listCaseServiceRequests(deps.pool, context.tenantId, caseId, 50);
    return { service_requests: page.map(publicServiceRequest) };
  });

  app.post(`${API_PREFIX}/cases/:caseId/service-requests`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    const body = createBody.parse(request.body);
    const { owner } = await assertCaseAccess(deps.pool, context, caseId);
    const actorType = actorTypeFor(context, owner);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      case_id: caseId,
      category: body.category,
      details: JSON.stringify(body.details ?? {}),
      actor_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /cases/{caseId}/service-requests',
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
      async (tx) => {
        const created = await createServiceRequest(tx, {
          tenantId: context.tenantId,
          caseId,
          category: body.category,
          createdBy: context.userId,
          actorType,
          ...(body.details !== undefined ? { details: body.details as JsonObject } : {}),
          correlationId: String(request.id),
        });
        return {
          result: publicServiceRequest(created),
          aggregateType: 'ServiceRequest',
          aggregateId: created.serviceRequestId,
        };
      },
    );

    if (!run.replayed) {
      return reply.status(201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: true };
  });

  app.get(`${API_PREFIX}/service-requests/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    await assertCaseAccess(deps.pool, context, serviceRequest.caseId);
    return publicServiceRequest(serviceRequest);
  });

  app.post(`${API_PREFIX}/service-requests/:id/commands/:command`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id, command } = commandParams.parse(request.params);
    const body = commandBody.parse(request.body ?? {});
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    const supportCase = await findCase(deps.pool, context.tenantId, serviceRequest.caseId);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const owner = supportCase.veteranUserId === context.userId;
    if (!owner) assertResponder(context);
    if (owner && !VETERAN_COMMANDS.includes(command)) {
      assertResponder(context);
    }
    const actorType = actorTypeFor(context, owner);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      service_request_id: id,
      command,
      reason: body.reason ?? null,
      to: body.to ?? null,
      expected_status: body.expected_status ?? null,
      grantee_id: body.grantee_id ?? null,
      actor_id: context.userId,
    });
    const scope = commandScope({
      command: `POST /service-requests/{id}/commands/${command}`,
      aggregateType: 'ServiceRequest',
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
        const updated = await executeServiceRequestCommandInTx(
          tx,
          {
            tenantId: context.tenantId,
            serviceRequestId: id,
            command,
            actorId: context.userId,
            actorType,
            ...(body.reason !== undefined ? { reason: body.reason } : {}),
            ...(body.to !== undefined ? { to: body.to as ServiceRequest['status'] } : {}),
            ...(body.expected_status !== undefined
              ? { expectedStatus: body.expected_status as ServiceRequest['status'] }
              : {}),
            ...(body.grantee_id !== undefined ? { granteeId: body.grantee_id } : {}),
            correlationId: String(request.id),
          },
          {
            disclosureGuard: async ({ tenantId, caseId, granteeId }) => {
              const parent = await findCase(tx, tenantId, caseId);
              if (parent === undefined) throw new ResourceNotVisibleError();
              await requireDisclosure(tx, {
                tenantId,
                veteranUserId: parent.veteranUserId,
                permission: 'can_share',
                scope: 'service_request_fulfillment',
                granteeType: 'SERVICE_PROVIDER',
                granteeId,
                purpose: 'service request assignment',
              });
            },
          },
        );
        return {
          result: publicServiceRequest(updated),
          aggregateType: 'ServiceRequest',
          aggregateId: updated.serviceRequestId,
        };
      },
    );

    return { ...run.result, replayed: run.replayed };
  });
}
