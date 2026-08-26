/**
 * Service Request read models over `/api/v0`.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.3 / DISPATCH.md §1 / §4
 * - SUAS-specs API.md §4 (session; server-derived tenant); §6 (no existence leakage)
 * - SUAS-specs CASES.md / RESPONDER_WORKFLOWS.md (veteran owner or responder)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { assertResponder, ResourceNotVisibleError } from '../../authz/index.js';
import {
  findCase,
  findServiceRequest,
  listCaseServiceRequests,
  type ServiceRequest,
} from '../../coordination/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface ServiceRequestRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const caseIdParams = z.object({ caseId: z.string().uuid() });

function publicServiceRequest(request: ServiceRequest) {
  return {
    service_request_id: request.serviceRequestId,
    case_id: request.caseId,
    category: request.category,
    status: request.status,
  };
}

export function registerServiceRequestRoutes(
  app: FastifyInstance,
  deps: ServiceRequestRouteDeps,
): void {
  app.get(`${API_PREFIX}/cases/:caseId/service-requests`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    const supportCase = await findCase(deps.pool, context.tenantId, caseId);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const owner = supportCase.veteranUserId === context.userId;
    if (!owner) assertResponder(context);
    const page = await listCaseServiceRequests(deps.pool, context.tenantId, caseId, 50);
    return { service_requests: page.map(publicServiceRequest) };
  });

  app.get(`${API_PREFIX}/service-requests/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    const supportCase = await findCase(deps.pool, context.tenantId, serviceRequest.caseId);
    if (supportCase === undefined) throw new ResourceNotVisibleError();
    const owner = supportCase.veteranUserId === context.userId;
    if (!owner) assertResponder(context);
    return publicServiceRequest(serviceRequest);
  });
}
