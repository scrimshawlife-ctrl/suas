/**
 * Veteran consent grant projection and sync write commands.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.2 (`GET /consents`, grant/revoke commands)
 * - SUAS-specs CONSENT.md §2 / §4 / §6 / §7
 * - SUAS-specs API.md §4 (session; server-derived tenant/actor), §7 (idempotency)
 * - SUAS-specs EVENT_MODEL.md §3 (`CONSENT_GRANTED`, `CONSENT_REVOKED`)
 * - SUAS-specs PRIVACY.md (self grants only; no cross-veteran leakage)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from '../authenticate.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import {
  CONSENT_PERMISSIONS,
  CONSENT_SCOPES,
  findConsentGrant,
  GRANTEE_TYPES,
  grantConsent,
  listGrantsForVeteran,
  revokeConsent,
  type ConsentGrant,
} from '../../consent/index.js';
import { appendDomainEvent } from '../../events/index.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../../idempotency/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface ConsentRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
}

const idParams = z.object({ id: z.string().uuid() });

const grantBody = z.object({
  permission: z.enum(CONSENT_PERMISSIONS),
  scope: z.enum(CONSENT_SCOPES),
  purpose: z.string().min(1).max(512),
  grantee_type: z.enum(GRANTEE_TYPES),
  grantee_id: z.string().uuid(),
  consent_template_version: z.string().min(1).max(256),
  expires_at: z.string().datetime().optional(),
});

class MissingIdempotencyKeyError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;
  constructor() {
    super('Idempotency-Key header is required for this command (SUAS-specs API.md §7).');
    this.name = 'MissingIdempotencyKeyError';
  }
}

function readIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MissingIdempotencyKeyError();
  }
  return value.trim();
}

function publicGrant(grant: ConsentGrant) {
  return {
    consent_grant_id: grant.consentGrantId,
    permission: grant.permission,
    scope: grant.scope,
    purpose: grant.purpose,
    grantee_type: grant.granteeType,
    grantee_id: grant.granteeId,
    consent_template_version: grant.consentTemplateVersion,
    status: grant.status,
    granted_at: grant.grantedAt.toISOString(),
    expires_at: grant.expiresAt?.toISOString() ?? null,
    revoked_at: grant.revokedAt?.toISOString() ?? null,
  };
}

export function registerConsentRoutes(app: FastifyInstance, deps: ConsentRouteDeps): void {
  app.get(`${API_PREFIX}/consents`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const grants = await listGrantsForVeteran(deps.pool, context.tenantId, context.userId);
    return { consents: grants.map(publicGrant) };
  });

  app.post(`${API_PREFIX}/consents`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = grantBody.parse(request.body);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const fingerprint = fingerprintRequest({
      permission: body.permission,
      scope: body.scope,
      purpose: body.purpose,
      grantee_type: body.grantee_type,
      grantee_id: body.grantee_id,
      consent_template_version: body.consent_template_version,
      expires_at: body.expires_at ?? null,
      veteran_user_id: context.userId,
    });
    const scope = commandScope({
      command: 'POST /consents',
      aggregateType: 'ConsentGrant',
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
        const grant = await grantConsent(tx, {
          tenantId: context.tenantId,
          veteranUserId: context.userId,
          permission: body.permission,
          scope: body.scope,
          purpose: body.purpose,
          granteeType: body.grantee_type,
          granteeId: body.grantee_id,
          consentTemplateVersion: body.consent_template_version,
          ...(body.expires_at !== undefined ? { expiresAt: new Date(body.expires_at) } : {}),
        });
        const appended = await appendDomainEvent(tx, {
          eventType: 'CONSENT_GRANTED',
          aggregateType: 'ConsentGrant',
          aggregateId: grant.consentGrantId,
          tenantId: context.tenantId,
          actorType: 'VETERAN',
          actorId: context.userId,
          payload: {
            permission: grant.permission,
            scope: grant.scope,
            grantee_type: grant.granteeType,
            grantee_id: grant.granteeId,
          },
          idempotencyKey: `consent-granted:${idempotencyKey}`,
          correlationId: String(request.id),
        });
        const projection = publicGrant(grant);
        return {
          result: projection,
          aggregateType: 'ConsentGrant',
          aggregateId: grant.consentGrantId,
          eventId: appended.event.eventId,
        };
      },
    );

    if (!run.replayed) {
      return reply.status(201).send({ ...run.result, replayed: false });
    }
    return { ...run.result, replayed: true };
  });

  app.post(`${API_PREFIX}/consents/:id/commands/revoke`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);

    const existing = await findConsentGrant(deps.pool, context.tenantId, id);
    if (existing === undefined || existing.veteranUserId !== context.userId) {
      throw new ResourceNotVisibleError();
    }

    const fingerprint = fingerprintRequest({
      consent_grant_id: id,
      veteran_user_id: context.userId,
      command: 'revoke',
    });
    const scope = commandScope({
      command: 'POST /consents/{id}/commands/revoke',
      aggregateType: 'ConsentGrant',
      aggregateId: id,
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
        const owned = await findConsentGrant(tx, context.tenantId, id);
        if (owned === undefined || owned.veteranUserId !== context.userId) {
          throw new ResourceNotVisibleError();
        }
        const revoked = await revokeConsent(tx, context.tenantId, id);
        // Already revoked (or raced) — return current owned projection without inventing state.
        const grant = revoked ?? owned;
        const appended = await appendDomainEvent(tx, {
          eventType: 'CONSENT_REVOKED',
          aggregateType: 'ConsentGrant',
          aggregateId: grant.consentGrantId,
          tenantId: context.tenantId,
          actorType: 'VETERAN',
          actorId: context.userId,
          payload: {
            permission: grant.permission,
            scope: grant.scope,
            status: grant.status,
          },
          idempotencyKey: `consent-revoked:${idempotencyKey}`,
          correlationId: String(request.id),
        });
        const projection = publicGrant(grant);
        return {
          result: projection,
          aggregateType: 'ConsentGrant',
          aggregateId: grant.consentGrantId,
          eventId: appended.event.eventId,
        };
      },
    );

    return { ...run.result, replayed: run.replayed };
  });
}
