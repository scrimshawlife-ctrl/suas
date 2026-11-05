/**
 * Service Request reads and released write commands over `/api/v0`.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.3 / DISPATCH.md §1 / §3 / §4 / §8
 * - SUAS-specs API.md §4 / §7; CASES.md; RESPONDER_WORKFLOWS.md
 * - V1_PROJECT_PLAN.md §2.1: the requester owns a request; the person who accepted it
 *   runs its commands; any signed-in person in the right county can list and accept.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import { ForbiddenError, ResourceNotVisibleError } from '../../authz/index.js';
import type { AuthContext } from '../../authz/index.js';
import { resolveCaseAccess, type CaseAccess } from '../case-access.js';
import { requireDisclosure } from '../../consent/index.js';
import {
  acceptServiceRequest,
  createServiceRequest,
  DEFAULT_PAGE_SIZE,
  executeServiceRequestCommandInTx,
  findActiveAssignment,
  findCase,
  findServiceRequest,
  listCaseServiceRequests,
  MAX_PAGE_SIZE,
  readRequestList,
  SERVICE_CATEGORIES,
  SERVICE_REQUEST_COMMANDS,
  type ServiceRequest,
  type ServiceRequestCommand,
} from '../../coordination/index.js';
import type { Queryable } from '../../db/index.js';
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

const listQuery = z.object({
  ownership: z.enum(['open', 'mine']).default('open'),
  // API.md §5: cursor + limit, default 20, maximum 100.
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});

const commandBody = z.object({
  reason: z.string().min(1).max(512).optional(),
  to: z.string().min(1).max(64).optional(),
  expected_status: z.string().min(1).max(64).optional(),
  grantee_id: z.string().uuid().optional(),
});

/** Commands the requester may issue on their own request. */
const VETERAN_COMMANDS: readonly ServiceRequestCommand[] = ['SUBMIT', 'CANCEL', 'CONFIRM'];

function publicServiceRequest(request: ServiceRequest) {
  return {
    service_request_id: request.serviceRequestId,
    case_id: request.caseId,
    category: request.category,
    status: request.status,
  };
}

/**
 * DISPATCH.md §4 names the *assigned* actor for every non-requester transition. In v1
 * that is the person who accepted the case. The one wider row is
 * `CREATED → SUBMITTED`, whose actor is "creator / assigned", so the creator may
 * also submit.
 *
 * Runs inside the command transaction: CASES.md §5 requires authorization to be
 * re-checked at mutation time, not trusted from an earlier read.
 */
async function assertAssignedAccepter(
  db: Queryable,
  context: AuthContext,
  serviceRequest: ServiceRequest,
  command: ServiceRequestCommand,
): Promise<void> {
  const assignment = await findActiveAssignment(db, serviceRequest.caseId);
  if (assignment?.acceptedByUserId === context.userId) return;
  if (command === 'SUBMIT' && serviceRequest.createdBy === context.userId) return;
  throw new ForbiddenError(
    'Only the person who accepted this case may run this command (SUAS-specs DISPATCH.md §4).',
  );
}

function actorTypeFor(access: CaseAccess): 'VETERAN' | 'USER' {
  return access.owner ? 'VETERAN' : 'USER';
}

export function registerServiceRequestRoutes(
  app: FastifyInstance,
  deps: ServiceRequestRouteDeps,
): void {
  app.get(`${API_PREFIX}/cases/:caseId/service-requests`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    await resolveCaseAccess(deps.pool, context, caseId);
    const page = await listCaseServiceRequests(deps.pool, context.tenantId, caseId, 50);
    return { service_requests: page.map(publicServiceRequest) };
  });

  app.post(`${API_PREFIX}/cases/:caseId/service-requests`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    const body = createBody.parse(request.body);
    const access = await resolveCaseAccess(deps.pool, context, caseId);
    const actorType = actorTypeFor(access);
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

  /**
   * The list for people who can accept (plan F4): `open` is requests in the caller's
   * county, plus bordering counties once widened; `mine` is requests the caller
   * accepted. Only category, county and status are shown before accepting.
   */
  app.get(`${API_PREFIX}/service-requests`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const query = listQuery.parse(request.query);
    const page = await readRequestList(
      deps.pool,
      context.tenantId,
      context.userId,
      { ownership: query.ownership },
      { limit: query.limit, ...(query.cursor !== undefined ? { cursor: query.cursor } : {}) },
    );
    return {
      service_requests: page.requests.map((item) => ({
        service_request_id: item.serviceRequestId,
        case_id: item.caseId,
        category: item.category,
        status: item.status,
        county: item.county,
        widened: item.widened,
        created_at: item.createdAt.toISOString(),
      })),
      next_cursor: page.nextCursor ?? null,
    };
  });

  /** First accept wins (plan F4). The loser gets 409 ALREADY_CLAIMED and writes nothing. */
  app.post(`${API_PREFIX}/service-requests/:id/accept`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const result = await acceptServiceRequest(deps.pool, {
      tenantId: context.tenantId,
      serviceRequestId: id,
      acceptedByUserId: context.userId,
      correlationId: String(request.id),
    });
    return {
      service_request_id: id,
      case_id: result.supportCase.caseId,
      case_status: result.supportCase.status,
      assignment_id: result.assignment.caseAssignmentId,
    };
  });

  app.get(`${API_PREFIX}/service-requests/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    await resolveCaseAccess(deps.pool, context, serviceRequest.caseId);
    return publicServiceRequest(serviceRequest);
  });

  app.post(`${API_PREFIX}/service-requests/:id/commands/:command`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id, command } = commandParams.parse(request.params);
    const body = commandBody.parse(request.body ?? {});
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    const access = await resolveCaseAccess(deps.pool, context, serviceRequest.caseId);
    if (access.owner && !VETERAN_COMMANDS.includes(command)) {
      // The requester gets only their own commands, unless they also hold the case,
      // which resolveCaseAccess never allows (no accepting your own request).
      throw new ForbiddenError(
        'Only the person who accepted this case may run this command (SUAS-specs DISPATCH.md §4).',
      );
    }
    const actorType = actorTypeFor(access);
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
        if (actorType === 'USER') {
          await assertAssignedAccepter(tx, context, serviceRequest, command);
        }
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
