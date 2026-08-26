/**
 * SUAS-admin adapter catalog and configuration.
 *
 * Spec citations:
 * - SUAS-specs ADMIN.md §2-§3 (MFA + audit; enable/disable accepted adapters;
 *   never expose secrets)
 * - SUAS-specs API.md §4 (authenticated session; command endpoints)
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { SuasConfig } from '../../config/index.js';
import { SERVICE_CATEGORIES } from '../../coordination/index.js';
import {
  disableAdapterConfiguration,
  enableAdapterConfiguration,
  listAdapterCatalog,
  listAdapterConfigurations,
  seedManualAdapterConfigurations,
  setAdapterRouting,
} from '../../fulfillment/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { assertMfaElevated, assertSuasAdmin } from '../../authz/index.js';
import { authenticate } from '../authenticate.js';

export interface AdminAdapterRouteDeps {
  readonly pool: Pool;
  readonly config: SuasConfig;
  readonly sessionSecret: string | undefined;
}

const tenantQuery = z.object({ tenant_id: z.string().uuid() });

const enableBody = z.object({
  tenant_id: z.string().uuid(),
  adapter_id: z.string().min(1).max(128),
  capability: z.enum(SERVICE_CATEGORIES),
  coverage_counties: z.array(z.string().min(1).max(64)).max(64).optional(),
  routing_priority: z.number().int().min(0).max(10_000).optional(),
});

const disableBody = z.object({
  tenant_id: z.string().uuid(),
  adapter_id: z.string().min(1).max(128),
  capability: z.enum(SERVICE_CATEGORIES),
});

const routingBody = z.object({
  tenant_id: z.string().uuid(),
  adapter_id: z.string().min(1).max(128),
  capability: z.enum(SERVICE_CATEGORIES),
  coverage_counties: z.array(z.string().min(1).max(64)).max(64),
  routing_priority: z.number().int().min(0).max(10_000),
});

function publicConfiguration(view: {
  adapterConfigurationId: string;
  tenantId: string;
  adapterId: string;
  capability: string;
  integrationMode: string;
  enabled: boolean;
  routingPriority: number;
  health: string;
  coverageCounties: readonly string[];
  secretPresence: string;
  catalogLabel: string;
}) {
  return {
    adapter_configuration_id: view.adapterConfigurationId,
    tenant_id: view.tenantId,
    adapter_id: view.adapterId,
    capability: view.capability,
    integration_mode: view.integrationMode,
    enabled: view.enabled,
    routing_priority: view.routingPriority,
    health: view.health,
    coverage_counties: [...view.coverageCounties],
    secret_presence: view.secretPresence,
    label: view.catalogLabel,
  };
}

export function registerAdminAdapterRoutes(
  app: FastifyInstance,
  deps: AdminAdapterRouteDeps,
): void {
  const gate = async (request: Parameters<typeof authenticate>[2]) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    assertSuasAdmin(context);
    assertMfaElevated(context, 'Administer provider adapters');
    return context;
  };

  app.get(`${API_PREFIX}/admin/adapter-catalog`, async (request) => {
    await gate(request);
    return {
      adapters: listAdapterCatalog(deps.config).map((entry) => ({
        adapter_id: entry.adapterId,
        capability: entry.capability,
        integration_mode: entry.integrationMode,
        decision: entry.decision,
        label: entry.label,
        secret_presence: entry.secretPresence,
      })),
    };
  });

  app.get(`${API_PREFIX}/admin/adapter-configurations`, async (request) => {
    await gate(request);
    const query = tenantQuery.parse(request.query);
    await seedManualAdapterConfigurations(deps.pool, query.tenant_id);
    const configurations = await listAdapterConfigurations(deps.pool, deps.config, query.tenant_id);
    return { configurations: configurations.map(publicConfiguration) };
  });

  app.post(`${API_PREFIX}/admin/adapter-configurations/commands/enable`, async (request) => {
    const context = await gate(request);
    const body = enableBody.parse(request.body);
    const view = await enableAdapterConfiguration(deps.pool, deps.config, {
      tenantId: body.tenant_id,
      adapterId: body.adapter_id,
      capability: body.capability,
      actorId: context.userId,
      ...(body.coverage_counties !== undefined ? { coverageCounties: body.coverage_counties } : {}),
      ...(body.routing_priority !== undefined ? { routingPriority: body.routing_priority } : {}),
      correlationId: String(request.id),
    });
    return publicConfiguration(view);
  });

  app.post(`${API_PREFIX}/admin/adapter-configurations/commands/disable`, async (request) => {
    const context = await gate(request);
    const body = disableBody.parse(request.body);
    const view = await disableAdapterConfiguration(deps.pool, deps.config, {
      tenantId: body.tenant_id,
      adapterId: body.adapter_id,
      capability: body.capability,
      actorId: context.userId,
      correlationId: String(request.id),
    });
    return publicConfiguration(view);
  });

  app.post(`${API_PREFIX}/admin/adapter-configurations/commands/set-routing`, async (request) => {
    const context = await gate(request);
    const body = routingBody.parse(request.body);
    const view = await setAdapterRouting(deps.pool, deps.config, {
      tenantId: body.tenant_id,
      adapterId: body.adapter_id,
      capability: body.capability,
      actorId: context.userId,
      coverageCounties: body.coverage_counties,
      routingPriority: body.routing_priority,
      correlationId: String(request.id),
    });
    return publicConfiguration(view);
  });
}
