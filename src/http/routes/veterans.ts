/**
 * Veteran self status projection.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.1 (`GET /veterans/me`)
 * - SUAS-specs API.md §2 / §4 (session; server-derived tenant/actor)
 * - SUAS-specs PRIVACY.md (minimum necessary; self-profile only)
 * - SUAS-specs MVP_REFERENCE.md §5–§7 (category cards + QRF truthfulness)
 * - SUAS-specs AUTH.md §2 (enrolled contact channels)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../authenticate.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { findNonClosedCase } from '../../coordination/index.js';
import { findUserById } from '../../identity/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { CATEGORY_CARDS } from '../../ui/categories.js';
import { presentQrfState } from '../../ui/qrf.js';
import { readActiveQrf } from '../../ui/read.js';

export interface VeteranRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

export function registerVeteranRoutes(app: FastifyInstance, deps: VeteranRouteDeps): void {
  app.get(`${API_PREFIX}/veterans/me`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const user = await findUserById(deps.pool, context.tenantId, context.userId);
    if (user === undefined) throw new ResourceNotVisibleError();

    const openCase = await findNonClosedCase(deps.pool, context.tenantId, context.userId);
    const activeQrf = await readActiveQrf(deps.pool, context.tenantId, context.userId);

    return {
      user_id: user.userId,
      status: user.status,
      enrolled_channels: {
        email: user.email !== undefined,
        phone: user.phone !== undefined,
      },
      open_case:
        openCase === undefined
          ? null
          : {
              case_id: openCase.caseId,
              status: openCase.status,
              priority_signal_level: openCase.prioritySignalLevel ?? null,
            },
      active_qrf:
        activeQrf === undefined
          ? null
          : (() => {
              const presentation = presentQrfState(activeQrf.facts);
              return {
                service_request_id: activeQrf.serviceRequestId,
                state: presentation.state,
                headline: presentation.headline,
                cancellable: presentation.cancellable,
              };
            })(),
      categories: CATEGORY_CARDS.map((card) => ({
        label: card.label,
        disposition: card.disposition,
        category: card.category ?? null,
        note: card.note ?? null,
      })),
    };
  });
}
