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
import { assertResponder, ResourceNotVisibleError } from '../../authz/index.js';
import { claimCase, findCase, readCaseQueue, type SupportCase } from '../../coordination/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface CaseRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });
const listQuery = z.object({
  ownership: z.enum(['unassigned', 'mine']).default('unassigned'),
});

function publicCase(supportCase: SupportCase) {
  return {
    case_id: supportCase.caseId,
    status: supportCase.status,
    priority_signal_level: supportCase.prioritySignalLevel ?? null,
  };
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
}
