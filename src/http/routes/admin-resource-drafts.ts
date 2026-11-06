/**
 * Catalog builder: Resource Draft extraction, review, and publish (SUAS admin only).
 *
 * Spec citations:
 * - V1_PROJECT_PLAN.md §2.1 "Catalog builder", §4.3 F8
 * - SUAS-specs ADMIN.md §2 (SUAS admin + MFA + audit), RESOURCES.md §5, §6
 * - SUAS-specs API.md §4 (session; server-derived tenant), §5 (cursor and limit),
 *   §6 (canonical errors)
 *
 * Drafts are never visible to Veterans: they live in `resource_drafts`, and only
 * `publish` creates a Resource. Model failures are answered here with a plain
 * message, because the global error handler hides the text of 5xx responses.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { assertMfaElevated, assertSuasAdmin } from '../../authz/index.js';
import {
  createResourceDrafts,
  discardResourceDraft,
  DRAFT_DEFAULT_PAGE_SIZE,
  DRAFT_MAX_PAGE_SIZE,
  draftChangesSchema,
  editResourceDraft,
  extractResourceDrafts,
  findResourceDraft,
  listResourceDrafts,
  MAX_SOURCE_TEXT_CHARS,
  publishResourceDraft,
  RESOURCE_DRAFT_STATUSES,
  ResourceDraftNotFoundError,
  sourceLinkSchema,
  type ExtractionFailure,
  type ResourceDraft,
} from '../../catalog/index.js';
import { withTransaction } from '../../db/index.js';
import type { ModelInferencePort } from '../../inference/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { authenticate } from '../authenticate.js';

export interface AdminResourceDraftRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly modelInference: ModelInferencePort;
}

const UNAVAILABLE_MESSAGE =
  'The catalog builder is not available right now, so no drafts can be extracted. ' +
  'Resources can still be created without it.';

const FAILURE_MESSAGES: Record<Exclude<ExtractionFailure, 'unavailable'>, string> = {
  timeout: 'The catalog builder took too long to answer. No drafts were created. Try again.',
  refused: 'The catalog builder declined to read this text. No drafts were created.',
  invalid: 'The catalog builder could not process this text. No drafts were created.',
  invalid_output:
    'The catalog builder returned an answer that could not be used. No drafts were created.',
};

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  status: z.enum(RESOURCE_DRAFT_STATUSES).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(DRAFT_MAX_PAGE_SIZE).default(DRAFT_DEFAULT_PAGE_SIZE),
});

const extractBody = z
  .object({
    source_text: z.string().trim().min(1).max(MAX_SOURCE_TEXT_CHARS),
    source_link: sourceLinkSchema,
  })
  .strict();

function publicDraft(draft: ResourceDraft) {
  return {
    resource_draft_id: draft.resourceDraftId,
    status: draft.status,
    source_link: draft.sourceLink,
    service_name: draft.serviceName,
    category: draft.category,
    counties: [...draft.counties],
    eligibility: draft.eligibility ?? null,
    hours: draft.hours ?? null,
    contact_method: draft.contactMethod ?? null,
    contact_method_kind: draft.contactMethodKind ?? null,
    referral_method: draft.referralMethod ?? null,
    cost: draft.cost ?? null,
    published_resource_id: draft.publishedResourceId ?? null,
    reviewed_by: draft.reviewedBy ?? null,
    reviewed_at: draft.reviewedAt?.toISOString() ?? null,
    created_at: draft.createdAt.toISOString(),
    updated_at: draft.updatedAt.toISOString(),
  };
}

function replyExtractionFailure(reply: FastifyReply, failure: ExtractionFailure): FastifyReply {
  if (failure === 'unavailable') {
    return reply
      .status(503)
      .send({ error: { code: 'CATALOG_BUILDER_UNAVAILABLE', message: UNAVAILABLE_MESSAGE } });
  }
  return reply
    .status(502)
    .send({ error: { code: 'CATALOG_EXTRACTION_FAILED', message: FAILURE_MESSAGES[failure] } });
}

export function registerAdminResourceDraftRoutes(
  app: FastifyInstance,
  deps: AdminResourceDraftRouteDeps,
): void {
  const gate = async (request: Parameters<typeof authenticate>[2], action: string) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertSuasAdmin(context);
    assertMfaElevated(context, action);
    return context;
  };

  app.get(`${API_PREFIX}/admin/resource-drafts`, async (request) => {
    const context = await gate(request, 'Review Resource Drafts');
    const query = listQuery.parse(request.query);
    const page = await listResourceDrafts(deps.pool, context.tenantId, {
      limit: query.limit,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    const available = deps.modelInference.isAvailable();
    return {
      builder: { available, message: available ? null : UNAVAILABLE_MESSAGE },
      drafts: page.drafts.map(publicDraft),
      limit: query.limit,
      next_cursor: page.nextCursor ?? null,
    };
  });

  app.get(`${API_PREFIX}/admin/resource-drafts/:id`, async (request) => {
    const context = await gate(request, 'Review Resource Drafts');
    const { id } = idParams.parse(request.params);
    const draft = await findResourceDraft(deps.pool, context.tenantId, id);
    if (draft === undefined) throw new ResourceDraftNotFoundError();
    return publicDraft(draft);
  });

  app.post(`${API_PREFIX}/admin/resource-drafts/commands/extract`, async (request, reply) => {
    const context = await gate(request, 'Extract Resource Drafts');
    const body = extractBody.parse(request.body);
    const extraction = await extractResourceDrafts(deps.modelInference, {
      sourceText: body.source_text,
      sourceLink: body.source_link,
    });
    if (!extraction.ok) return replyExtractionFailure(reply, extraction.failure);

    const drafts = await withTransaction(deps.pool, (tx) =>
      createResourceDrafts(tx, {
        tenantId: context.tenantId,
        actorId: context.userId,
        sourceLink: body.source_link,
        resources: extraction.resources,
      }),
    );
    return { drafts: drafts.map(publicDraft) };
  });

  app.post(`${API_PREFIX}/admin/resource-drafts/:id/commands/edit`, async (request) => {
    const context = await gate(request, 'Edit a Resource Draft');
    const { id } = idParams.parse(request.params);
    const changes = draftChangesSchema.parse(request.body);
    const draft = await withTransaction(deps.pool, (tx) =>
      editResourceDraft(tx, {
        tenantId: context.tenantId,
        resourceDraftId: id,
        actorId: context.userId,
        changes,
      }),
    );
    return publicDraft(draft);
  });

  app.post(`${API_PREFIX}/admin/resource-drafts/:id/commands/discard`, async (request) => {
    const context = await gate(request, 'Discard a Resource Draft');
    const { id } = idParams.parse(request.params);
    const draft = await withTransaction(deps.pool, (tx) =>
      discardResourceDraft(tx, {
        tenantId: context.tenantId,
        resourceDraftId: id,
        actorId: context.userId,
      }),
    );
    return publicDraft(draft);
  });

  // The publish is the verification act (plan §2.1): the admin has read the draft
  // against its source link, so the Resource is created, verified, and activated.
  app.post(`${API_PREFIX}/admin/resource-drafts/:id/commands/publish`, async (request) => {
    const context = await gate(request, 'Publish a Resource Draft');
    const { id } = idParams.parse(request.params);
    const { draft, resource } = await withTransaction(deps.pool, (tx) =>
      publishResourceDraft(tx, {
        tenantId: context.tenantId,
        resourceDraftId: id,
        actorId: context.userId,
      }),
    );
    return { draft: publicDraft(draft), resource_id: resource.resourceId };
  });
}
