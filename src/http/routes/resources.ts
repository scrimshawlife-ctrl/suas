/**
 * Resource catalog and immediate-resource JSON surfaces.
 *
 * Spec citations:
 * - SUAS-specs APIS.md §2.4 (`GET /resources`)
 * - SUAS-specs RESOURCES.md §6 (veteran-facing fields only), §8 (bounded list),
 *   §10 (tenant-scoped; no eligibility judgement)
 * - SUAS-specs SAFETY.md §3.1 / SAFETY_COPY.md §1 (approved immediate-resource
 *   slot; D-012); ENVIRONMENT.md §3 (`SUAS_SAFETY_COPY_MODE`)
 * - SUAS-specs API.md §2 (`/api/v0`), §4 (session; server-derived tenant),
 *   §5 (bounded pagination), §6 (canonical errors; no existence leakage)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { SafetyCopyMode } from '../../config/index.js';
import { authenticate } from '../authenticate.js';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { SERVICE_CATEGORIES } from '../../coordination/index.js';
import {
  findResource,
  freshnessBand,
  requiresStaleWarning,
  searchResources,
  type Resource,
  type ResourceSearchResult,
} from '../../fulfillment/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { resolveImmediateResourceSlot } from '../../ui/safety.js';

export interface ResourceRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly safetyCopyMode: SafetyCopyMode;
}

const idParams = z.object({ id: z.string().uuid() });

const listQuery = z.object({
  category: z.enum(SERVICE_CATEGORIES).optional(),
  county: z.string().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Public catalog projection — RESOURCES.md §6 + list freshness (UI parity). */
function publicCatalogResource(result: ResourceSearchResult) {
  const resource = result.resource;
  return {
    resource_id: resource.resourceId,
    service_name: resource.serviceName,
    category: resource.category,
    counties: [...resource.counties],
    hours: resource.hours ?? null,
    cost: resource.cost ?? null,
    contact_method: resource.contactMethod ?? null,
    contact_method_kind: resource.contactMethodKind ?? null,
    freshness: result.freshness,
    stale_warning: result.staleWarning,
  };
}

function publicCatalogFromResource(resource: Resource, now = new Date()) {
  const freshness = freshnessBand(resource.lastVerifiedAt, now);
  return publicCatalogResource({
    resource,
    freshness,
    staleWarning: requiresStaleWarning(freshness),
  });
}

export function registerResourceRoutes(app: FastifyInstance, deps: ResourceRouteDeps): void {
  app.get(`${API_PREFIX}/resources`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const query = listQuery.parse(request.query);
    const results = await searchResources(
      deps.pool,
      context.tenantId,
      {
        activeOnly: true,
        ...(query.category !== undefined ? { category: query.category } : {}),
        ...(query.county !== undefined ? { county: query.county } : {}),
      },
      { limit: query.limit },
    );
    return {
      resources: results.map(publicCatalogResource),
      limit: query.limit,
    };
  });

  app.get(`${API_PREFIX}/resources/:id`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const resource = await findResource(deps.pool, context.tenantId, id);
    // Inactive and missing share 404 — no existence leakage across tenants/state.
    if (resource === undefined || !resource.active) {
      throw new ResourceNotVisibleError();
    }
    return publicCatalogFromResource(resource);
  });

  app.get(`${API_PREFIX}/immediate-resources`, async (request) => {
    await authenticate(deps.pool, deps.sessionSecret, request);
    const slot = resolveImmediateResourceSlot(deps.safetyCopyMode);
    return {
      state: slot.state,
      basis: slot.basis,
      placeholder: slot.placeholder ?? null,
      resources: slot.resources.map((entry) => ({
        label: entry.label,
        destination: entry.destination,
        approved_under: entry.approvedUnder,
      })),
    };
  });
}
