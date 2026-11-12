/**
 * LOCAL-only developer conveniences for the SUAS iOS app.
 *
 * These routes exist ONLY to make a realistic end-to-end demo possible on a
 * developer laptop. They are registered exclusively when
 * `config.environment === 'LOCAL'` (see http/server.ts) and refuse to do
 * anything otherwise. They never run in TEST, STAGING, or PRODUCTION.
 *
 * What they provide:
 * - `GET /api/v0/dev/last-challenge?destination=...` returns the most recent
 *   passwordless code/token that the `fake` delivery channel captured, so the
 *   app's real login screen (issue challenge -> enter code -> verify) can be
 *   exercised without a live email/SMS provider. This is only possible because
 *   LOCAL uses the in-memory `RecordingChallengeDelivery` in `fake` mode, which
 *   retains delivered messages for inspection. It reads nothing from the
 *   database and cannot expose a real veteran's code (there are none in LOCAL).
 * - `POST /api/v0/dev/service-requests/:id/simulate` advances a Service Request
 *   one legal step along the released fulfillment path (SUBMIT -> TRIAGE ->
 *   START_MATCHING -> ASSIGN -> ACCEPT -> START -> FULFILL -> CONFIRM) using the
 *   same released coordination commands the accepter's routes use. It is a
 *   LOCAL stand-in for an accepter/provider actually working the request so the
 *   app's live status screen visibly progresses. No real provider is contacted
 *   and no real-world effect occurs.
 *
 * None of this is a released product surface. It is a synthetic-LOCAL harness.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  normalizeDestination,
  RecordingChallengeDelivery,
  type ChallengeDeliveryPort,
} from '../../auth/index.js';
import { authenticate } from '../authenticate.js';
import { resolveRequestAccess } from '../case-access.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import {
  executeServiceRequestCommand,
  findServiceRequest,
  type ServiceRequestCommand,
  type ServiceRequestStatus,
} from '../../coordination/index.js';
import {
  MODEL_FAILURE_KINDS,
  ScriptedModelInference,
  type ModelInferencePort,
} from '../../inference/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface DevRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly delivery: ChallengeDeliveryPort;
  /** The app's model port; only the scripted fake can be fed turns. */
  readonly modelInference?: ModelInferencePort | undefined;
}

// A scripted turn is either `{ok:true,text,toolCalls}` or `{ok:false,failure}`.
const scriptedTurnsBody = z.object({
  turns: z
    .array(
      z.union([
        z.object({
          ok: z.literal(true),
          text: z.string(),
          toolCalls: z.array(z.object({ id: z.string(), name: z.string(), input: z.unknown() })),
        }),
        z.object({
          ok: z.literal(false),
          failure: z.enum(MODEL_FAILURE_KINDS),
        }),
      ]),
    )
    .max(50),
});

const lastChallengeQuery = z.object({
  destination: z.string().min(3).max(320),
});

const simulateParams = z.object({ id: z.string().uuid() });

/**
 * The single forward step to run from a given status, and a human label the app
 * can show. Terminal / off-path statuses map to `undefined` (nothing to do).
 */
const FORWARD_STEP: Partial<
  Record<
    ServiceRequestStatus,
    { readonly command: ServiceRequestCommand; readonly grantee?: string }
  >
> = {
  CREATED: { command: 'SUBMIT' },
  SUBMITTED: { command: 'TRIAGE' },
  TRIAGED: { command: 'START_MATCHING' },
  // ASSIGN is the one externally-disclosing edge; in LOCAL we supply a
  // synthetic grantee and a disclosure guard that always allows (see below).
  MATCHING: { command: 'ASSIGN', grantee: 'local-sim-provider' },
  ASSIGNED: { command: 'ACCEPT' },
  ACCEPTED: { command: 'START' },
  IN_PROGRESS: { command: 'FULFILL' },
  FULFILLED: { command: 'CONFIRM' },
};

export function registerDevRoutes(app: FastifyInstance, deps: DevRouteDeps): void {
  app.get(`${API_PREFIX}/dev/last-challenge`, async (request, reply) => {
    const query = lastChallengeQuery.parse(request.query);
    const destination = normalizeDestination(query.destination);

    if (!(deps.delivery instanceof RecordingChallengeDelivery)) {
      return reply.status(409).send({
        error: {
          code: 'DEV_DELIVERY_NOT_RECORDING',
          message:
            'The active challenge delivery does not retain codes. Set SUAS_EMAIL_MODE=fake ' +
            '(and SUAS_SMS_MODE=fake for phone) in LOCAL to capture codes for the app.',
        },
      });
    }

    const last = deps.delivery.lastFor(destination);
    if (last === undefined) {
      return reply.status(404).send({
        error: {
          code: 'DEV_NO_CHALLENGE',
          message: 'No challenge has been delivered to that destination yet.',
        },
      });
    }

    return {
      destination: last.destination,
      method: last.method,
      channel: last.channel,
      // In LOCAL this is a synthetic code for a synthetic user. It is exactly
      // what the app should submit to /auth/challenges/commands/verify.
      code: last.secret,
      expires_at: last.expiresAt.toISOString(),
    };
  });

  // Lets a local web app exercise the Intake Assistant: with SUAS_MODEL_INFERENCE_MODE=fake
  // the port answers "unavailable" until turns are queued here.
  app.post(`${API_PREFIX}/dev/model-inference/turns`, async (request, reply) => {
    const body = scriptedTurnsBody.parse(request.body);
    if (!(deps.modelInference instanceof ScriptedModelInference)) {
      return reply.status(409).send({
        error: {
          code: 'DEV_MODEL_NOT_SCRIPTED',
          message: 'The model port is not the scripted fake. Set SUAS_MODEL_INFERENCE_MODE=fake.',
        },
      });
    }
    deps.modelInference.enqueue(
      ...body.turns.map((turn) =>
        turn.ok
          ? {
              ok: true as const,
              text: turn.text,
              toolCalls: turn.toolCalls.map(({ id, name, input }) => ({ id, name, input })),
            }
          : turn,
      ),
    );
    return reply.status(202).send({ queued: body.turns.length });
  });

  app.post(`${API_PREFIX}/dev/service-requests/:id/simulate`, async (request) => {
    // Only the requester or the current holder may advance a request, as on the real
    // routes; anyone else gets the same 404 as a request that does not exist.
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = simulateParams.parse(request.params);

    const current = await findServiceRequest(deps.pool, context.tenantId, id);
    if (current === undefined) throw new ResourceNotVisibleError();
    await resolveRequestAccess(deps.pool, context, current);

    const step = FORWARD_STEP[current.status];
    if (step === undefined) {
      return {
        service_request_id: id,
        status: current.status,
        advanced: false,
        note: 'No forward step from this status (terminal or awaiting a different actor).',
      };
    }

    const updated = await executeServiceRequestCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        serviceRequestId: id,
        command: step.command,
        actorId: context.userId,
        actorType: 'SYSTEM',
        ...(step.grantee !== undefined ? { granteeId: step.grantee } : {}),
        correlationId: String(request.id),
      },
      {
        // LOCAL simulation: the disclosure decision is a no-op. Nothing leaves
        // the process, so there is no real third party to consent to.
        disclosureGuard: async () => {},
      },
    );

    return {
      service_request_id: id,
      status: updated.status,
      advanced: true,
      command: step.command,
    };
  });
}
