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
import { draftDetailsInput, SUMMARY_MAX, TIMING_MAX } from '../../intake/tools.js';
import { requireCounty, requireVerifiedVeteran } from '../../identity/index.js';
import { resolveCaseAccess, resolveRequestAccess, type RequestAccess } from '../case-access.js';
import { requireDisclosure } from '../../consent/index.js';
import {
  acceptServiceRequest,
  createServiceRequest,
  DEFAULT_PAGE_SIZE,
  DESTINATION_MAX,
  editServiceRequestInTx,
  executeServiceRequestCommandInTx,
  findCase,
  findDisplayName,
  findServiceRequest,
  listCaseServiceRequests,
  MAX_PAGE_SIZE,
  MEETING_PLACE_MAX,
  notifyRequester,
  readHelperRequestCounts,
  readRequestList,
  readServiceRequestDetail,
  REQUEST_RELEASED_REASON,
  requestHeldInCurrentCycle,
  SERVICE_CATEGORIES,
  SERVICE_REQUEST_COMMANDS,
  type ServiceRequest,
  type ServiceRequestCommand,
} from '../../coordination/index.js';
import type { JsonObject } from '../../jobs/index.js';
import type { Queryable } from '../../db/index.js';
import {
  commandScope,
  fingerprintRequest,
  readCommandRecord,
  runIdempotentCommand,
} from '../../idempotency/index.js';
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
  // The same bounded fields the plain form and drafts use; unknown keys are refused.
  details: draftDetailsInput.partial().optional(),
});

const listQuery = z.object({
  ownership: z.enum(['open', 'mine', 'requested']).default('open'),
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

/** Same bounds as the plain form; `null` clears an optional field. */
const editBody = z
  .object({
    summary: z.string().trim().min(1).max(SUMMARY_MAX).optional(),
    timing: z.string().trim().min(1).max(TIMING_MAX).nullable().optional(),
    meeting_place: z.string().trim().min(1).max(MEETING_PLACE_MAX).nullable().optional(),
    destination: z.string().trim().min(1).max(DESTINATION_MAX).nullable().optional(),
    expected_status: z.string().min(1).max(64).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).some((key) => key !== 'expected_status'), {
    message: 'Provide at least one field to change.',
  });

/**
 * Commands only the requester may issue on their own request. The accepter runs every
 * other command and never these three: submitting is asking for help, cancelling
 * withdraws the ask, and confirming is the requester saying the need was met.
 */
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
 * that is the person who accepted this request.
 *
 * Runs inside the command transaction: CASES.md §5 requires authorization to be
 * re-checked at mutation time, not trusted from an earlier read.
 */
async function assertRequestHolder(db: Queryable, context: AuthContext, requestId: string) {
  if (await requestHeldInCurrentCycle(db, context.tenantId, requestId, context.userId)) {
    return;
  }
  throw new ForbiddenError(
    'Only the person who accepted this request may run this command (SUAS-specs DISPATCH.md §4).',
  );
}

function actorTypeFor(owner: boolean): 'VETERAN' | 'USER' {
  return owner ? 'VETERAN' : 'USER';
}

/** The idempotency scope and fingerprint of one caller's request command. */
function commandIdentity(
  id: string,
  command: ServiceRequestCommand,
  body: z.infer<typeof commandBody>,
  userId: string,
): { fingerprint: string; scope: string } {
  return {
    fingerprint: fingerprintRequest({
      service_request_id: id,
      command,
      reason: body.reason ?? null,
      to: body.to ?? null,
      expected_status: body.expected_status ?? null,
      grantee_id: body.grantee_id ?? null,
      actor_id: userId,
    }),
    scope: commandScope({
      command: `POST /service-requests/{id}/commands/${command}`,
      aggregateType: 'ServiceRequest',
      aggregateId: id,
      actorId: userId,
    }),
  };
}

/**
 * The stored result of an identical, completed command, or undefined. It never throws: a
 * missing key falls through to the normal checks, so it cannot tell an outsider anything.
 */
async function readCompletedReplay(
  db: Queryable,
  input: {
    tenantId: string;
    header: string | string[] | undefined;
    commandScope: string;
    requestFingerprint: string;
  },
): Promise<JsonObject | undefined> {
  const raw = Array.isArray(input.header) ? input.header[0] : input.header;
  const idempotencyKey = raw?.trim();
  if (idempotencyKey === undefined || idempotencyKey === '') return undefined;
  const record = await readCommandRecord(db, {
    tenantId: input.tenantId,
    commandScope: input.commandScope,
    idempotencyKey,
  });
  if (record?.state !== 'COMPLETED' || record.requestFingerprint !== input.requestFingerprint) {
    return undefined;
  }
  return record.result ?? {};
}

/**
 * The whole request for its requester or accepter. Callers pass an access already resolved
 * by `resolveRequestAccess`; the counterpart name is the other person's.
 */
async function buildRequestDetail(
  pool: Pool,
  tenantId: string,
  serviceRequest: ServiceRequest,
  access: RequestAccess,
) {
  const detail = await readServiceRequestDetail(pool, tenantId, serviceRequest.serviceRequestId);
  if (detail === undefined) throw new ResourceNotVisibleError();
  const counterpartUserId = access.owner
    ? serviceRequest.acceptedByUserId
    : access.supportCase.veteranUserId;
  const counterpartDisplayName =
    counterpartUserId === undefined
      ? null
      : await findDisplayName(pool, tenantId, counterpartUserId);
  return {
    ...publicServiceRequest(serviceRequest),
    viewer_role: access.owner ? 'REQUESTER' : 'ACCEPTER',
    summary: detail.summary,
    timing: detail.timing,
    meeting_place: detail.meetingPlace,
    destination: detail.destination,
    created_at: detail.createdAt.toISOString(),
    accepted_at: detail.acceptedAt?.toISOString() ?? null,
    widened: detail.widened,
    county: detail.county,
    counterpart_display_name: counterpartDisplayName,
  };
}

export function registerServiceRequestRoutes(
  app: FastifyInstance,
  deps: ServiceRequestRouteDeps,
): void {
  app.get(`${API_PREFIX}/cases/:caseId/service-requests`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    const access = await resolveCaseAccess(deps.pool, context, caseId);
    // A helper sees only the requests they accepted, never the Veteran's other requests.
    const page = await listCaseServiceRequests(
      deps.pool,
      context.tenantId,
      caseId,
      50,
      access.owner ? undefined : context.userId,
    );
    return { service_requests: page.map(publicServiceRequest) };
  });

  app.post(`${API_PREFIX}/cases/:caseId/service-requests`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { caseId } = caseIdParams.parse(request.params);
    const body = createBody.parse(request.body);
    const access = await resolveCaseAccess(deps.pool, context, caseId);
    // R8.3: only the requester adds needs; a helper on the case is refused.
    if (!access.owner) {
      throw new ForbiddenError(
        'Only the person who asked for help may add a request to this case.',
      );
    }
    await requireVerifiedVeteran(deps.pool, context);
    await requireCounty(deps.pool, context);
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
          actorType: 'VETERAN',
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
   * Three lists (plan F4). `open`: requests the caller could accept, in their county plus
   * bordering counties once widened, with category, county, status and the one-line
   * summary (never timing or the meeting place). `mine`: requests the caller accepted,
   * with the requester's display name. `requested`: the caller's own requests in any
   * status, newest first. Only `open` and `mine` need a county; `requested` needs only
   * a signed-in person.
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
    const counts =
      query.ownership === 'mine'
        ? await readHelperRequestCounts(deps.pool, context.tenantId, context.userId)
        : undefined;
    return {
      service_requests: page.requests.map((item) => {
        if (query.ownership === 'requested') {
          return {
            service_request_id: item.serviceRequestId,
            case_id: item.caseId,
            category: item.category,
            status: item.status,
            summary: item.summary,
            created_at: item.createdAt.toISOString(),
            updated_at: item.updatedAt.toISOString(),
            closed_at: item.closedAt?.toISOString() ?? null,
          };
        }
        return {
          service_request_id: item.serviceRequestId,
          case_id: item.caseId,
          category: item.category,
          status: item.status,
          county: item.county,
          widened: item.widened,
          summary: item.summary,
          created_at: item.createdAt.toISOString(),
          ...(query.ownership === 'mine'
            ? { counterpart_display_name: item.requesterDisplayName }
            : {}),
        };
      }),
      next_cursor: page.nextCursor ?? null,
      ...(counts !== undefined
        ? {
            counts: {
              helping_now: counts.helpingNow,
              closed_last_30_days: counts.closedLast30Days,
            },
          }
        : {}),
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
    };
  });

  /**
   * The whole request, for its requester and the one helper who accepted it (anyone else,
   * including another helper on the same Veteran's case, gets the same 404 as a request
   * that does not exist). The counterpart name is the other person's: the accepter's for
   * the requester (null until someone accepts), the requester's for the accepter.
   */
  app.get(`${API_PREFIX}/service-requests/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    const access = await resolveRequestAccess(deps.pool, context, serviceRequest);
    return buildRequestDetail(deps.pool, context.tenantId, serviceRequest, access);
  });

  /**
   * R8.1: the requester edits a request nobody has accepted yet. Registered as a fixed route
   * so it is not read as a `:command`. Strangers get 404 and the accepter 403, as for the
   * requester-only commands. The stored result holds ids only (the text is never kept in
   * the idempotency table), so the response re-reads the current detail, replay or not.
   */
  app.post(`${API_PREFIX}/service-requests/:id/commands/edit`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const body = editBody.parse(request.body);
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    const access = await resolveRequestAccess(deps.pool, context, serviceRequest);
    if (!access.owner) {
      throw new ForbiddenError(
        'Only the person who asked for help may run this command (SUAS-specs DISPATCH.md §4).',
      );
    }
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const scope = commandScope({
      command: 'POST /service-requests/{id}/commands/edit',
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
        // The edited text is fingerprinted as a hash only, never stored.
        requestFingerprint: fingerprintRequest({
          service_request_id: id,
          changes: JSON.stringify(body),
          actor_id: context.userId,
        }),
      },
      async (tx) => {
        const edited = await editServiceRequestInTx(tx, {
          tenantId: context.tenantId,
          serviceRequestId: id,
          actorId: context.userId,
          changes: {
            ...(body.summary !== undefined ? { summary: body.summary } : {}),
            ...(body.timing !== undefined ? { timing: body.timing } : {}),
            ...(body.meeting_place !== undefined ? { meetingPlace: body.meeting_place } : {}),
            ...(body.destination !== undefined ? { destination: body.destination } : {}),
          },
          ...(body.expected_status !== undefined
            ? { expectedStatus: body.expected_status as ServiceRequest['status'] }
            : {}),
          correlationId: String(request.id),
        });
        return {
          result: publicServiceRequest(edited),
          aggregateType: 'ServiceRequest',
          aggregateId: edited.serviceRequestId,
        };
      },
    );

    const current = await findServiceRequest(deps.pool, context.tenantId, id);
    if (current === undefined) throw new ResourceNotVisibleError();
    return {
      ...(await buildRequestDetail(deps.pool, context.tenantId, current, access)),
      replayed: run.replayed,
    };
  });

  app.post(`${API_PREFIX}/service-requests/:id/commands/:command`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id, command } = commandParams.parse(request.params);
    const body = commandBody.parse(request.body ?? {});
    const serviceRequest = await findServiceRequest(deps.pool, context.tenantId, id);
    if (serviceRequest === undefined) throw new ResourceNotVisibleError();
    const { fingerprint, scope } = commandIdentity(id, command, body, context.userId);
    // A release ends the helper's access, so their retry reads the stored result first
    // (API.md §7). Scope and fingerprint carry the caller's id, so it is only ever theirs.
    if (command === 'RELEASE') {
      const replay = await readCompletedReplay(deps.pool, {
        tenantId: context.tenantId,
        header: request.headers['idempotency-key'],
        commandScope: scope,
        requestFingerprint: fingerprint,
      });
      if (replay !== undefined) return { ...replay, replayed: true };
    }
    const access = await resolveRequestAccess(deps.pool, context, serviceRequest);
    // CONFIRM, CANCEL and SUBMIT belong to the requester alone; every other command
    // belongs to this request's accepter alone (resolveRequestAccess never makes one
    // person both).
    if (access.owner !== VETERAN_COMMANDS.includes(command)) {
      throw new ForbiddenError(
        access.owner
          ? 'Only the person who accepted this request may run this command (SUAS-specs DISPATCH.md §4).'
          : 'Only the person who asked for help may run this command (SUAS-specs DISPATCH.md §4).',
      );
    }
    // Submitting is the act of requesting help; cancelling or confirming is not.
    if (access.owner && command === 'SUBMIT') await requireVerifiedVeteran(deps.pool, context);
    const actorType = actorTypeFor(access.owner);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);

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
          await assertRequestHolder(tx, context, id);
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

    // After the commit, tell the requester. A failed notice never undoes the release.
    if (command === 'RELEASE' && !run.replayed) {
      try {
        await notifyRequester(deps.pool, {
          tenantId: context.tenantId,
          requesterUserId: access.supportCase.veteranUserId,
          serviceRequestId: id,
          reason: REQUEST_RELEASED_REASON,
          dedupeKey: `request-released:${id}:${idempotencyKey}`,
        });
      } catch {
        request.log.warn({ service_request_id: id }, 'release notice could not be queued');
      }
    }

    return { ...run.result, replayed: run.replayed };
  });
}
