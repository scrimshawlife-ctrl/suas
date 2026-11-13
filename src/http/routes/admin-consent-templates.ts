/**
 * Consent template versions: SUAS-admin create and publish, and the published read.
 *
 * Spec citations:
 * - SUAS-specs CONSENT.md §6 (grants cite a published template version; copy is
 *   administrator-supplied), ADMIN.md §2 "Consent templates" (SUAS admin, MFA, audit)
 * - SUAS-specs API.md §4 (session), §6 (409 codes), §7 (Idempotency-Key on create)
 * - V1_MVP_PROPOSAL.md R9.3 (contributor proposal, specs #72, not released): the routes,
 *   and the owner's answer that one MFA admin plus an Audit Event is enough to publish
 *
 * Templates are global (ADMIN.md §2), so the routes read no tenant from the request. The
 * Audit Event sits in the admin's session tenant and names the version as its target.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { assertMfaElevated, assertSuasAdmin, ResourceNotVisibleError } from '../../authz/index.js';
import {
  CONSENT_TEMPLATE_KEY_PATTERN,
  CONSENT_TEMPLATE_VERSION_KEY_PATTERN,
  ConsentTemplateNotDraftError,
  createNextConsentTemplateVersion,
  findConsentTemplateVersion,
  findPublishedConsentTemplate,
  listConsentTemplateVersions,
  publishConsentTemplateVersion,
  type ConsentTemplateVersion,
} from '../../consent/index.js';
import { withTransaction, type Queryable } from '../../db/index.js';
import { appendAuditEvent } from '../../events/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import type { JsonObject } from '../../jobs/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { authenticate } from '../authenticate.js';
import { readIdempotencyKey } from '../idempotency-header.js';

export interface AdminConsentTemplateRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

/** Template copy is free text an admin writes; the cap keeps rows and audits bounded. */
export const MAX_CONSENT_TEMPLATE_BODY_CHARS = 20_000;

const templateKey = z.string().min(1).max(64).regex(CONSENT_TEMPLATE_KEY_PATTERN);

const createBody = z
  .object({
    template_key: templateKey,
    body: z.string().trim().min(1).max(MAX_CONSENT_TEMPLATE_BODY_CHARS),
  })
  .strict();

const versionParams = z.object({
  version: z.string().max(80).regex(CONSENT_TEMPLATE_VERSION_KEY_PATTERN),
});

const publishedQuery = z.object({ purpose: templateKey });

function publicTemplate(template: ConsentTemplateVersion) {
  return {
    version_key: template.versionKey,
    template_key: template.templateKey,
    version: template.version,
    status: template.status,
    body: template.body ?? null,
    published_at: template.publishedAt?.toISOString() ?? null,
    created_at: template.createdAt.toISOString(),
  };
}

async function auditTemplate(
  tx: Queryable,
  input: {
    readonly template: ConsentTemplateVersion;
    readonly action: 'CREATE' | 'PUBLISH';
    readonly tenantId: string;
    readonly actorId: string;
    readonly correlationId: string;
    readonly payload: JsonObject;
  },
): Promise<void> {
  await appendAuditEvent(tx, {
    eventType:
      input.action === 'CREATE' ? 'CONSENT_TEMPLATE_VERSION_CREATED' : 'CONSENT_TEMPLATE_PUBLISHED',
    action: `${input.action}_CONSENT_TEMPLATE_VERSION`,
    targetType: 'ConsentTemplateVersion',
    targetId: input.template.versionKey,
    aggregateType: 'Tenant',
    aggregateId: input.tenantId,
    tenantId: input.tenantId,
    actorType: 'SUAS_ADMIN',
    actorId: input.actorId,
    // Key and version only: the template copy stays on its row.
    payload: {
      template_key: input.template.templateKey,
      version: input.template.version,
      ...input.payload,
    },
    correlationId: input.correlationId,
  });
}

export function registerAdminConsentTemplateRoutes(
  app: FastifyInstance,
  deps: AdminConsentTemplateRouteDeps,
): void {
  const gate = async (request: Parameters<typeof authenticate>[2], action: string) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertSuasAdmin(context);
    assertMfaElevated(context, action);
    return context;
  };

  app.get(`${API_PREFIX}/admin/consent-templates`, async (request) => {
    await gate(request, 'Review consent templates');
    const templates = await listConsentTemplateVersions(deps.pool);
    return { templates: templates.map(publicTemplate) };
  });

  // A new DRAFT version of a key; the server numbers it. API.md §7: a retry with the same
  // key replays the version it made instead of making another.
  app.post(`${API_PREFIX}/admin/consent-templates`, async (request, reply) => {
    const context = await gate(request, 'Create a consent template version');
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const body = createBody.parse(request.body);
    const run = await runIdempotentCommand(
      deps.pool,
      {
        tenantId: context.tenantId,
        commandScope: commandScope({
          command: 'POST /admin/consent-templates',
          actorId: context.userId,
        }),
        idempotencyKey,
        requestFingerprint: fingerprintRequest({
          template_key: body.template_key,
          body: body.body,
        }),
      },
      async (tx) => {
        const template = await createNextConsentTemplateVersion(tx, {
          templateKey: body.template_key,
          body: body.body,
        });
        await auditTemplate(tx, {
          template,
          action: 'CREATE',
          tenantId: context.tenantId,
          actorId: context.userId,
          correlationId: String(request.id),
          payload: {},
        });
        return { result: { version_key: template.versionKey } };
      },
    );
    const versionKey = run.result.version_key;
    const template =
      typeof versionKey === 'string'
        ? await findConsentTemplateVersion(deps.pool, versionKey)
        : undefined;
    if (template === undefined) throw new ResourceNotVisibleError();
    return reply
      .status(run.replayed ? 200 : 201)
      .send({ ...publicTemplate(template), replayed: run.replayed });
  });

  // One MFA admin publishes (R9.3 owner answer 2). The key's earlier PUBLISHED version
  // becomes SUPERSEDED in the same transaction as the Audit Event.
  app.post(`${API_PREFIX}/admin/consent-templates/:version/commands/publish`, async (request) => {
    const context = await gate(request, 'Publish a consent template version');
    const { version } = versionParams.parse(request.params);
    const published = await withTransaction(deps.pool, async (tx) => {
      const outcome = await publishConsentTemplateVersion(tx, version, context.userId);
      if (outcome === undefined) {
        const existing = await findConsentTemplateVersion(tx, version);
        if (existing === undefined) throw new ResourceNotVisibleError();
        throw new ConsentTemplateNotDraftError(existing.status);
      }
      await auditTemplate(tx, {
        template: outcome.template,
        action: 'PUBLISH',
        tenantId: context.tenantId,
        actorId: context.userId,
        correlationId: String(request.id),
        payload: { superseded_version_keys: [...outcome.supersededVersionKeys] },
      });
      return outcome;
    });
    return {
      ...publicTemplate(published.template),
      superseded_version_keys: [...published.supersededVersionKeys],
    };
  });

  // Any signed-in client reads the version a new grant must cite, so no client hard-codes
  // a seed key. `purpose` is the template key; 404 when none is published.
  app.get(`${API_PREFIX}/consent-templates/published`, async (request) => {
    await authenticate(deps.pool, deps.sessionSecret, request);
    const { purpose } = publishedQuery.parse(request.query);
    const template = await findPublishedConsentTemplate(deps.pool, purpose);
    if (template === undefined) throw new ResourceNotVisibleError();
    return {
      version_key: template.versionKey,
      template_key: template.templateKey,
      version: template.version,
      body: template.body ?? null,
      published_at: template.publishedAt?.toISOString() ?? null,
    };
  });
}
