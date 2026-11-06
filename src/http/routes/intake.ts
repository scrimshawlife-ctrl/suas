/**
 * Intake Assistant, Service Request Drafts and the plain request form.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 (Intake Assistant, Service Request
 * Draft, plain form always available), §4.3 F3, F12. AGENTS.md rule 14: the model
 * only proposes a draft; a Service Request exists only after the Veteran's submit.
 * SUAS-specs API.md §4 (server-derived tenant and actor), §6 (errors), §7
 * (Idempotency-Key on consequential commands).
 *
 * Every route is the Veteran's own, so each calls `requireVerifiedVeteran` right
 * after `authenticate`. Intake text is read from request bodies and handed to the
 * inference port and the draft table only: it is never logged, never put in an
 * idempotency fingerprint or stored result, and never returned except to its owner.
 *
 * The meeting place is different in one way: it is saved on the draft and then in the
 * Service Request's `details` (same database), and the plain form's idempotency
 * fingerprint includes it as a SHA-256 hash. It is not in any stored command result,
 * and it is never logged, listed, or put in an event or audit payload.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import { requireCounty, requireVerifiedVeteran } from '../../identity/veteran-gate.js';
import {
  EMPTY_DRAFT_FIELDS,
  NOT_AVAILABLE_NOTICE,
  runIntakeAssistant,
  type IntakeResource,
  type IntakeRun,
} from '../../intake/assistant.js';
import {
  createDraft,
  INTAKE_TEXT_TOTAL_MAX,
  draftDetails,
  DraftNotEditableError,
  DraftTooLongError,
  findOwnedDraft,
  saveDraftContent,
  type ServiceRequestDraft,
} from '../../intake/drafts.js';
import { createDatabaseIntakeHost } from '../../intake/resource-search.js';
import { createSubmittedRequestInTx, submitDraftInTx } from '../../intake/submit.js';
import { MEETING_PLACE_MAX } from '../../coordination/index.js';
import {
  draftDetailsInput,
  INTAKE_CATEGORIES,
  SUMMARY_MAX,
  TIMING_MAX,
} from '../../intake/tools.js';
import type { ModelInferencePort } from '../../inference/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface IntakeRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly modelInference: ModelInferencePort;
}

/** One Veteran message. The bound keeps a prompt, and a stored draft, small. */
export const INTAKE_MESSAGE_MAX = 2_000;

const idParams = z.object({ id: z.string().uuid() });
const messageBody = z.object({ text: z.string().trim().min(1).max(INTAKE_MESSAGE_MAX) }).strict();
const editBody = z
  .object({
    category: z.enum(INTAKE_CATEGORIES).optional(),
    summary: z.string().trim().min(1).max(SUMMARY_MAX).optional(),
    timing: z.string().trim().min(1).max(TIMING_MAX).nullable().optional(),
    meeting_place: z.string().trim().min(1).max(MEETING_PLACE_MAX).nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Provide at least one field.' });
const requestFormBody = draftDetailsInput.extend({ category: z.enum(INTAKE_CATEGORIES) }).strict();

/** Where a client goes when the assistant cannot answer. Always available. */
const REQUEST_FORM = { method: 'POST', path: `${API_PREFIX}/service-requests` } as const;

function draftView(draft: ServiceRequestDraft) {
  return {
    draft_id: draft.draftId,
    status: draft.status,
    category: draft.fields.category,
    summary: draft.fields.summary,
    timing: draft.fields.timing,
    meeting_place: draft.fields.meetingPlace,
    service_request_id: draft.serviceRequestId ?? null,
    created_at: draft.createdAt.toISOString(),
    updated_at: draft.updatedAt.toISOString(),
    submitted_at: draft.submittedAt?.toISOString() ?? null,
  };
}

function resourceView(resource: IntakeResource) {
  return {
    resource_id: resource.resourceId,
    service_name: resource.serviceName,
    category: resource.category,
    counties: [...resource.counties],
    hours: resource.hours,
    cost: resource.cost,
    contact_method: resource.contactMethod,
    contact_method_kind: resource.contactMethodKind,
    freshness: resource.freshness,
    stale_warning: resource.staleWarning,
  };
}

function turnView(run: IntakeRun, draft: ServiceRequestDraft | undefined) {
  return {
    outcome: run.outcome,
    assistant_message:
      run.outcome === 'FALLBACK_FORM' || run.assistantText === '' ? null : run.assistantText,
    not_available_yet: run.notAvailableYet,
    notice: run.notAvailableYet ? NOT_AVAILABLE_NOTICE : null,
    draft: draft === undefined ? null : draftView(draft),
    resources: run.resources.map(resourceView),
    request_form: run.outcome === 'FALLBACK_FORM' ? REQUEST_FORM : null,
  };
}

export function registerIntakeRoutes(app: FastifyInstance, deps: IntakeRouteDeps): void {
  /** Whether to show the assistant or go straight to the plain form. */
  app.get(`${API_PREFIX}/intake/status`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    return { assistant_available: deps.modelInference.isAvailable(), request_form: REQUEST_FORM };
  });

  /** First message: runs the assistant and, when it answers, stores a new draft. */
  app.post(`${API_PREFIX}/intake/drafts`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const body = messageBody.parse(request.body);

    const run = await runIntakeAssistant(
      deps.modelInference,
      createDatabaseIntakeHost(deps.pool, context.tenantId),
      { intakeText: body.text, draft: EMPTY_DRAFT_FIELDS },
    );
    // The model did not answer: store nothing, send the Veteran to the plain form.
    if (run.outcome === 'FALLBACK_FORM') return turnView(run, undefined);

    const draft = await createDraft(deps.pool, {
      draftId: randomUUID(),
      tenantId: context.tenantId,
      userId: context.userId,
      intakeText: body.text,
      fields: run.draft,
    });
    return reply.status(201).send(turnView(run, draft));
  });

  /** A follow-up message on a draft that is still open. */
  app.post(`${API_PREFIX}/intake/drafts/:id/messages`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const { id } = idParams.parse(request.params);
    const body = messageBody.parse(request.body);
    const draft = await findOwnedDraft(deps.pool, context.tenantId, context.userId, id);
    if (draft.status !== 'DRAFT') throw new DraftNotEditableError();
    const intakeText = `${draft.intakeText}\n\n${body.text}`;
    if (intakeText.length > INTAKE_TEXT_TOTAL_MAX) throw new DraftTooLongError();

    const run = await runIntakeAssistant(
      deps.modelInference,
      createDatabaseIntakeHost(deps.pool, context.tenantId),
      { intakeText, draft: draft.fields },
    );
    if (run.outcome === 'FALLBACK_FORM') return turnView(run, draft);

    const saved = await saveDraftContent(deps.pool, draft, { fields: run.draft, intakeText });
    return turnView(run, saved);
  });

  app.get(`${API_PREFIX}/intake/drafts/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const { id } = idParams.parse(request.params);
    const draft = await findOwnedDraft(deps.pool, context.tenantId, context.userId, id);
    return { ...draftView(draft), intake_text: draft.intakeText };
  });

  /** The Veteran edits the draft by hand. Only the four reviewed fields can change. */
  app.patch(`${API_PREFIX}/intake/drafts/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    const { id } = idParams.parse(request.params);
    const body = editBody.parse(request.body);
    const draft = await findOwnedDraft(deps.pool, context.tenantId, context.userId, id);
    const saved = await saveDraftContent(deps.pool, draft, {
      fields: {
        category: body.category ?? draft.fields.category,
        summary: body.summary ?? draft.fields.summary,
        timing: body.timing === undefined ? draft.fields.timing : body.timing,
        meetingPlace:
          body.meeting_place === undefined ? draft.fields.meetingPlace : body.meeting_place,
      },
    });
    return draftView(saved);
  });

  /** Submitting creates the Service Request. The only way a draft becomes one. */
  app.post(`${API_PREFIX}/intake/drafts/:id/submit`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    await requireCounty(deps.pool, context);
    const { id } = idParams.parse(request.params);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const scope = commandScope({
      command: 'POST /intake/drafts/{id}/submit',
      aggregateType: 'ServiceRequestDraft',
      aggregateId: id,
      actorId: context.userId,
    });

    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: scope,
        idempotencyKey,
        // The draft id alone identifies the command; the text is never fingerprinted.
        requestFingerprint: fingerprintRequest({ draft_id: id, actor_id: context.userId }),
      },
      async (tx) => {
        const submitted = await submitDraftInTx(tx, {
          tenantId: context.tenantId,
          userId: context.userId,
          draftId: id,
          correlationId: String(request.id),
        });
        return {
          result: {
            service_request: {
              service_request_id: submitted.serviceRequest.serviceRequestId,
              case_id: submitted.serviceRequest.caseId,
              category: submitted.serviceRequest.category,
              status: submitted.serviceRequest.status,
            },
            draft: draftView(submitted.draft),
          },
          aggregateType: 'ServiceRequest',
          aggregateId: submitted.serviceRequest.serviceRequestId,
        };
      },
    );
    if (!run.replayed) return reply.status(201).send({ ...run.result, replayed: false });
    return { ...run.result, replayed: true };
  });

  /**
   * The plain request form: same result as a submitted draft, with no model. The
   * client shows it whenever the assistant is unavailable or fails.
   */
  app.post(`${API_PREFIX}/service-requests`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    await requireVerifiedVeteran(deps.pool, context);
    await requireCounty(deps.pool, context);
    const body = requestFormBody.parse(request.body);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const details = draftDetails({
      category: body.category,
      summary: body.summary,
      timing: body.timing ?? null,
      meetingPlace: body.meeting_place ?? null,
    });
    const scope = commandScope({
      command: 'POST /service-requests',
      aggregateType: 'User',
      aggregateId: context.userId,
      actorId: context.userId,
    });

    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: scope,
        idempotencyKey,
        requestFingerprint: fingerprintRequest({
          category: body.category,
          details: JSON.stringify(details),
          actor_id: context.userId,
        }),
      },
      async (tx) => {
        const created = await createSubmittedRequestInTx(tx, {
          tenantId: context.tenantId,
          veteranUserId: context.userId,
          category: body.category,
          details: details,
          correlationId: String(request.id),
        });
        return {
          result: {
            service_request_id: created.serviceRequestId,
            case_id: created.caseId,
            category: created.category,
            status: created.status,
          },
          aggregateType: 'ServiceRequest',
          aggregateId: created.serviceRequestId,
        };
      },
    );
    if (!run.replayed) return reply.status(201).send({ ...run.result, replayed: false });
    return { ...run.result, replayed: true };
  });
}
