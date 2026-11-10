/**
 * Veteran self status projection.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.1 (`GET /veterans/me`)
 * - SUAS-specs API.md §2 / §4 (session; server-derived tenant/actor)
 * - SUAS-specs PRIVACY.md (minimum necessary; self-profile only)
 * - SUAS-specs MVP_REFERENCE.md §5–§7 (category cards + QRF truthfulness)
 * - SUAS-specs AUTH.md §2 (enrolled contact channels)
 * - V1_PROJECT_PLAN.md §2.1 / §4.3 F1 (county)
 * - suas-specs #72 R9.1 (proposal): VA Veteran Confirmation; D035_VA_CONFIRMATION_ADAPTER.md §9, §12
 *
 * The county and confirmation routes are open to any signed-in person: a person who is
 * not confirmed can still set a county and help others.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { hashCredential } from '../../auth/index.js';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { findCurrentCase } from '../../coordination/index.js';
import { commandScope, keyedFingerprintRequest } from '../../idempotency/fingerprint.js';
import { runIdempotentCommand } from '../../idempotency/run.js';
import {
  confirmVeteranStatus,
  readVeteranConfirmation,
  vaConfirmationRequestSchema,
  VeteranConfirmationRevokedError,
  VeteranConfirmationUnavailableError,
  type VaConfirmationProjection,
  type VeteranConfirmationPort,
  type VeteranConfirmationStanding,
} from '../../identity/index.js';
import { SERVICE_COUNTIES } from '../../identity/counties.js';
import { findUserById, setUserCounty, setUserDisplayName } from '../../identity/users.js';
import { API_PREFIX } from '../../release/pins.js';
import { CATEGORY_CARDS } from '../../ui/categories.js';
import { presentQrfState } from '../../ui/qrf.js';
import { readActiveQrf } from '../../ui/read.js';

export interface VeteranRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** Undefined when VA confirmation is disabled; the confirm route then answers 503. */
  readonly veteranConfirmation?: VeteranConfirmationPort;
}

const countyBody = z.object({ county: z.enum(SERVICE_COUNTIES) });
// Only length and emptiness are validated. The format hint ("First name and last
// initial, like Marcus T.") is guidance shown by the client.
const profileBody = z.object({ display_name: z.string().trim().min(1).max(40) });

/** Context label for the confirm fingerprint key: HMAC(session secret, label), never stored. */
export const VA_CONFIRMATION_FINGERPRINT_KEY_LABEL = 'suas:va-confirmation-fingerprint:v1';

/** The confirm result; never any projection value. */
function confirmationResult(standing: VeteranConfirmationStanding | undefined) {
  return {
    status: standing?.status ?? 'NOT_STARTED',
    not_confirmed_reason: standing?.notConfirmedReason ?? null,
    verified_at: standing?.verifiedAt?.toISOString() ?? null,
  };
}

function publicIdVerification(standing: VeteranConfirmationStanding | undefined) {
  return { method: 'VA_VETERAN_STATUS', ...confirmationResult(standing) };
}

/** 400 naming only the fields that failed, so no submitted value is echoed. */
class VeteranConfirmationInputError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(fields: readonly string[]) {
    super(`Check these fields: ${fields.join(', ')}.`);
    this.name = 'VeteranConfirmationInputError';
  }
}

function parseProjection(body: unknown): VaConfirmationProjection {
  const parsed = vaConfirmationRequestSchema.safeParse(body ?? {});
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? ['unknown fields'] : [issue.path.join('.') || 'body'],
  );
  throw new VeteranConfirmationInputError([...new Set(fields)]);
}

export function registerVeteranRoutes(app: FastifyInstance, deps: VeteranRouteDeps): void {
  app.get(`${API_PREFIX}/veterans/me`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const user = await findUserById(deps.pool, context.tenantId, context.userId);
    if (user === undefined) throw new ResourceNotVisibleError();

    const confirmation = await readVeteranConfirmation(deps.pool, context.tenantId, context.userId);
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
      id_verification: publicIdVerification(confirmation),
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
    const user = await setUserCounty(deps.pool, context.tenantId, context.userId, body.county);
    if (user === undefined) throw new ResourceNotVisibleError();
    return { county: user.county ?? null };
  });

  /** Signed-in only: a person can set a name before confirming Veteran status. */
  app.put(`${API_PREFIX}/veterans/me/profile`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = profileBody.parse(request.body);
    const user = await setUserDisplayName(
      deps.pool,
      context.tenantId,
      context.userId,
      body.display_name,
    );
    if (user === undefined) throw new ResourceNotVisibleError();
    return { display_name: user.displayName ?? null };
  });

  /**
   * One VA Veteran Confirmation attempt (R9.1). Already VERIFIED returns the standing with
   * no provider call and no attempt; REVOKED is refused (403) the same way. The
   * idempotency record keeps a keyed hash of the projection and the bounded result only.
   */
  app.post(`${API_PREFIX}/veterans/me/verification/va/confirm`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const port = deps.veteranConfirmation;
    if (port === undefined) throw new VeteranConfirmationUnavailableError();
    const projection = parseProjection(request.body);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);

    const current = await readVeteranConfirmation(deps.pool, context.tenantId, context.userId);
    if (current?.status === 'VERIFIED') return confirmationResult(current);
    if (current?.status === 'REVOKED') throw new VeteranConfirmationRevokedError();

    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: commandScope({
          command: 'POST /veterans/me/verification/va/confirm',
          aggregateType: 'User',
          aggregateId: context.userId,
          actorId: context.userId,
        }),
        idempotencyKey,
        requestFingerprint: keyedFingerprintRequest(
          hashCredential(deps.sessionSecret, VA_CONFIRMATION_FINGERPRINT_KEY_LABEL),
          { ...projection, actor_id: context.userId },
        ),
      },
      async (tx) => {
        const { verificationId, standing } = await confirmVeteranStatus(tx, port, {
          tenantId: context.tenantId,
          userId: context.userId,
          projection,
          correlationId: String(request.id),
        });
        return {
          result: confirmationResult(standing),
          ...(verificationId !== undefined
            ? { aggregateType: 'VeteranVerification', aggregateId: verificationId }
            : {}),
        };
      },
    );
    return run.result;
  });
}
