/**
 * Veteran self status projection.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.1 (`GET /veterans/me`)
 * - SUAS-specs API.md §2 / §4 (session; server-derived tenant/actor)
 * - SUAS-specs PRIVACY.md (minimum necessary; self-profile only)
 * - SUAS-specs MVP_REFERENCE.md §5–§7 (category cards + QRF truthfulness)
 * - SUAS-specs AUTH.md §2 (enrolled contact channels)
 * - V1_PROJECT_PLAN.md §2.1 / §4.3 F1 (county), F2 (ID scan + selfie status)
 *
 * The county and ID scan routes are open to any signed-in person: a person who has
 * not passed the scan can still set a county and help others.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { findCurrentCase } from '../../coordination/index.js';
import {
  changeUserCounty,
  changeUserDisplayName,
  readIdScanStatus,
  startIdScan,
  type IdScanView,
  type IdVerificationPort,
} from '../../identity/index.js';
import { SERVICE_COUNTIES } from '../../identity/counties.js';
import { findUserById } from '../../identity/users.js';
import { API_PREFIX } from '../../release/pins.js';
import { CATEGORY_CARDS } from '../../ui/categories.js';
import { presentQrfState } from '../../ui/qrf.js';
import { readActiveQrf } from '../../ui/read.js';

export interface VeteranRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** Undefined when ID verification is disabled; the scan then reports unavailable. */
  readonly idVerification?: IdVerificationPort;
}

const countyBody = z.object({ county: z.enum(SERVICE_COUNTIES) });
// Only length and emptiness are validated. The format hint ("First name and last
// initial, like Marcus T.") is guidance shown by the client.
const profileBody = z.object({ display_name: z.string().trim().min(1).max(40) });

function publicIdVerification(view: IdScanView) {
  return {
    method: 'ID_SCAN_SELFIE',
    status: view.status,
    verified_at: view.verifiedAt?.toISOString() ?? null,
  };
}

export function registerVeteranRoutes(app: FastifyInstance, deps: VeteranRouteDeps): void {
  app.get(`${API_PREFIX}/veterans/me`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const user = await findUserById(deps.pool, context.tenantId, context.userId);
    if (user === undefined) throw new ResourceNotVisibleError();

    const idScan = await readIdScanStatus(
      deps.pool,
      deps.idVerification,
      context.tenantId,
      context.userId,
    );
    const openCase = await findCurrentCase(deps.pool, context.tenantId, context.userId);
    const activeQrf = await readActiveQrf(deps.pool, context.tenantId, context.userId);

    return {
      user_id: user.userId,
      status: user.status,
      enrolled_channels: {
        email: user.email !== undefined,
        phone: user.phone !== undefined,
      },
      county: user.county ?? null,
      display_name: user.displayName ?? null,
      is_admin: context.isSuasAdmin,
      id_verification: publicIdVerification(idScan),
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
                category: activeQrf.category,
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

  app.put(`${API_PREFIX}/veterans/me/county`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = countyBody.parse(request.body);
    const user = await changeUserCounty(deps.pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      county: body.county,
      correlationId: String(request.id),
    });
    if (user === undefined) throw new ResourceNotVisibleError();
    return { county: user.county ?? null };
  });

  /** Signed-in only: a person can set a name before passing the ID scan. */
  app.put(`${API_PREFIX}/veterans/me/profile`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = profileBody.parse(request.body);
    const user = await changeUserDisplayName(deps.pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      displayName: body.display_name,
      correlationId: String(request.id),
    });
    if (user === undefined) throw new ResourceNotVisibleError();
    return { display_name: user.displayName ?? null };
  });

  app.get(`${API_PREFIX}/veterans/me/id-verification`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    return publicIdVerification(
      await readIdScanStatus(deps.pool, deps.idVerification, context.tenantId, context.userId),
    );
  });

  app.post(`${API_PREFIX}/veterans/me/id-verification/commands/start`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { view, created } = await startIdScan(
      deps.pool,
      deps.idVerification,
      context.tenantId,
      context.userId,
    );
    return reply.status(created ? 201 : 200).send(publicIdVerification(view));
  });
}
