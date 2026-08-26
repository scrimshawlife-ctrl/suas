/**
 * Veteran consent grant projection.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.2 (`GET /consents`)
 * - SUAS-specs CONSENT.md §2 / §7 (grant shape and status)
 * - SUAS-specs API.md §4 (session; server-derived tenant/actor)
 * - SUAS-specs PRIVACY.md (self grants only; no cross-veteran leakage)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { authenticate } from '../authenticate.js';
import { listGrantsForVeteran, type ConsentGrant } from '../../consent/index.js';
import { API_PREFIX } from '../../release/pins.js';

export interface ConsentRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
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
}
