/**
 * Tenant adapter configuration — admin enable/disable/routing.
 *
 * Spec citations:
 * - SUAS-specs ADMIN.md §3 (opaque adapter id, capability, mode, enabled,
 *   coverage/priority, normalized health, secret-presence; never secrets;
 *   disable does not delete history; enable without a closed decision is
 *   rejected; Manual Adapter paths are first-class configuration)
 * - SUAS-specs DATA_MODEL.md §7 (`provider_adapter_configurations`, no secrets)
 * - SUAS-specs PROVIDER_INTEGRATIONS.md §2 rule 9 (routing above the adapter)
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import type { ServiceCategory } from '../coordination/index.js';
import type { SuasConfig } from '../config/index.js';
import type { AdapterHealth, IntegrationMode } from './port.js';
import {
  ADAPTER_CATALOG,
  AdapterNotAcceptedError,
  assertCanEnable,
  findCatalogEntry,
  MANUAL_ADAPTER_CATALOG,
  secretPresence,
  type SecretPresence,
} from './catalog.js';
import type { AdapterConfiguration } from './router.js';

export interface AdapterConfigurationView extends AdapterConfiguration {
  readonly secretPresence: SecretPresence;
  readonly catalogLabel: string;
}

interface ConfigurationRow {
  adapter_configuration_id: string;
  tenant_id: string;
  adapter_id: string;
  capability: ServiceCategory;
  integration_mode: string;
  enabled: boolean;
  routing_priority: number;
  health: AdapterHealth;
  coverage_counties: string[];
}

function toConfiguration(row: ConfigurationRow): AdapterConfiguration {
  return {
    adapterConfigurationId: row.adapter_configuration_id,
    tenantId: row.tenant_id,
    adapterId: row.adapter_id,
    capability: row.capability,
    integrationMode: row.integration_mode,
    enabled: row.enabled,
    routingPriority: row.routing_priority,
    health: row.health,
    coverageCounties: row.coverage_counties,
  };
}

function withCatalog(config: SuasConfig, row: AdapterConfiguration): AdapterConfigurationView {
  const entry = findCatalogEntry(row.adapterId, row.capability);
  return {
    ...row,
    secretPresence: secretPresence(config, row.adapterId),
    catalogLabel: entry?.label ?? row.adapterId,
  };
}

const COLUMNS = `adapter_configuration_id, tenant_id, adapter_id, capability, integration_mode,
        enabled, routing_priority, health, coverage_counties`;

export async function listAdapterConfigurations(
  db: Queryable,
  config: SuasConfig,
  tenantId: string,
): Promise<readonly AdapterConfigurationView[]> {
  const result = await db.query<ConfigurationRow>(
    `SELECT ${COLUMNS}
     FROM provider_adapter_configurations
     WHERE tenant_id = $1
     ORDER BY capability ASC, routing_priority ASC, adapter_id ASC`,
    [tenantId],
  );
  return result.rows.map((row) => withCatalog(config, toConfiguration(row)));
}

export function listAdapterCatalog(
  config: SuasConfig,
): readonly (AdapterCatalogPublic & { readonly secretPresence: SecretPresence })[] {
  return ADAPTER_CATALOG.map((entry) => ({
    adapterId: entry.adapterId,
    capability: entry.capability,
    integrationMode: entry.integrationMode,
    decision: entry.decision,
    label: entry.label,
    secretPresence: secretPresence(config, entry.adapterId),
  }));
}

interface AdapterCatalogPublic {
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly integrationMode: IntegrationMode;
  readonly decision: string;
  readonly label: string;
}

/**
 * Ensure the four mandatory manuals exist and are enabled for this tenant.
 * Idempotent. Does not touch API adapter rows.
 */
export async function seedManualAdapterConfigurations(
  db: Pool | PoolClient,
  tenantId: string,
): Promise<readonly AdapterConfiguration[]> {
  const rows: AdapterConfiguration[] = [];
  for (const entry of MANUAL_ADAPTER_CATALOG) {
    const result = await db.query<ConfigurationRow>(
      `INSERT INTO provider_adapter_configurations
         (adapter_configuration_id, tenant_id, adapter_id, capability, integration_mode,
          enabled, routing_priority, health)
       VALUES ($1, $2, $3, $4, $5, true, 100, 'HEALTHY')
       ON CONFLICT (tenant_id, adapter_id, capability)
       DO UPDATE SET
         enabled = true,
         integration_mode = EXCLUDED.integration_mode,
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [randomUUID(), tenantId, entry.adapterId, entry.capability, entry.integrationMode],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Manual adapter seed returned no row.');
    rows.push(toConfiguration(row));
  }
  return rows;
}

export interface EnableAdapterInput {
  readonly tenantId: string;
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly actorId: string;
  readonly coverageCounties?: readonly string[];
  readonly routingPriority?: number;
  readonly correlationId?: string;
}

export async function enableAdapterConfiguration(
  pool: Pool,
  config: SuasConfig,
  input: EnableAdapterInput,
): Promise<AdapterConfigurationView> {
  const entry = assertCanEnable({
    adapterId: input.adapterId,
    capability: input.capability,
    secretPresence: secretPresence(config, input.adapterId),
  });

  return withTransaction(pool, async (tx) => {
    const result = await tx.query<ConfigurationRow>(
      `INSERT INTO provider_adapter_configurations
         (adapter_configuration_id, tenant_id, adapter_id, capability, integration_mode,
          enabled, routing_priority, coverage_counties, health)
       VALUES ($1, $2, $3, $4, $5, true, COALESCE($6, 100), COALESCE($7::text[], '{}'::text[]), 'HEALTHY')
       ON CONFLICT (tenant_id, adapter_id, capability)
       DO UPDATE SET
         enabled = true,
         integration_mode = EXCLUDED.integration_mode,
         routing_priority = COALESCE($6, provider_adapter_configurations.routing_priority),
         coverage_counties = COALESCE($7::text[], provider_adapter_configurations.coverage_counties),
         updated_at = now()
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.tenantId,
        entry.adapterId,
        entry.capability,
        entry.integrationMode,
        input.routingPriority ?? null,
        input.coverageCounties !== undefined ? [...input.coverageCounties] : null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('Enable adapter returned no row.');
    const configuration = toConfiguration(row);
    await appendAuditEvent(tx, {
      eventType: 'ADAPTER_CONFIGURATION_CHANGED',
      action: 'ENABLE_ADAPTER',
      targetType: 'ProviderAdapterConfiguration',
      targetId: configuration.adapterConfigurationId,
      aggregateType: 'ProviderAdapterConfiguration',
      aggregateId: configuration.adapterConfigurationId,
      tenantId: input.tenantId,
      actorType: 'SUAS_ADMIN',
      actorId: input.actorId,
      payload: {
        adapter_id: entry.adapterId,
        capability: entry.capability,
        enabled: true,
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return withCatalog(config, configuration);
  });
}

export interface DisableAdapterInput {
  readonly tenantId: string;
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly actorId: string;
  readonly correlationId?: string;
}

export class AdapterConfigurationNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Adapter configuration not found.');
    this.name = 'AdapterConfigurationNotFoundError';
  }
}

export class ManualAdapterRequiredError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(capability: ServiceCategory) {
    super(
      `The manual adapter for ${capability} cannot be disabled ` +
        `(SUAS-specs PROVIDER_INTEGRATIONS.md §2 rule 8; ADMIN.md §3).`,
    );
    this.name = 'ManualAdapterRequiredError';
  }
}

export async function disableAdapterConfiguration(
  pool: Pool,
  config: SuasConfig,
  input: DisableAdapterInput,
): Promise<AdapterConfigurationView> {
  const entry = findCatalogEntry(input.adapterId, input.capability);
  if (entry === undefined) {
    throw new AdapterNotAcceptedError(input.adapterId, input.capability);
  }
  if (entry.integrationMode === 'MANUAL_COORDINATION') {
    throw new ManualAdapterRequiredError(input.capability);
  }

  return withTransaction(pool, async (tx) => {
    const result = await tx.query<ConfigurationRow>(
      `UPDATE provider_adapter_configurations
          SET enabled = false, updated_at = now()
        WHERE tenant_id = $1 AND adapter_id = $2 AND capability = $3
        RETURNING ${COLUMNS}`,
      [input.tenantId, input.adapterId, input.capability],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AdapterConfigurationNotFoundError();
    const configuration = toConfiguration(row);
    await appendAuditEvent(tx, {
      eventType: 'ADAPTER_CONFIGURATION_CHANGED',
      action: 'DISABLE_ADAPTER',
      targetType: 'ProviderAdapterConfiguration',
      targetId: configuration.adapterConfigurationId,
      aggregateType: 'ProviderAdapterConfiguration',
      aggregateId: configuration.adapterConfigurationId,
      tenantId: input.tenantId,
      actorType: 'SUAS_ADMIN',
      actorId: input.actorId,
      payload: {
        adapter_id: input.adapterId,
        capability: input.capability,
        enabled: false,
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return withCatalog(config, configuration);
  });
}

export interface SetAdapterRoutingInput {
  readonly tenantId: string;
  readonly adapterId: string;
  readonly capability: ServiceCategory;
  readonly actorId: string;
  readonly coverageCounties: readonly string[];
  readonly routingPriority: number;
  readonly correlationId?: string;
}

export async function setAdapterRouting(
  pool: Pool,
  config: SuasConfig,
  input: SetAdapterRoutingInput,
): Promise<AdapterConfigurationView> {
  if (findCatalogEntry(input.adapterId, input.capability) === undefined) {
    throw new AdapterNotAcceptedError(input.adapterId, input.capability);
  }
  return withTransaction(pool, async (tx) => {
    const result = await tx.query<ConfigurationRow>(
      `UPDATE provider_adapter_configurations
          SET coverage_counties = $4::text[], routing_priority = $5, updated_at = now()
        WHERE tenant_id = $1 AND adapter_id = $2 AND capability = $3
        RETURNING ${COLUMNS}`,
      [
        input.tenantId,
        input.adapterId,
        input.capability,
        [...input.coverageCounties],
        input.routingPriority,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AdapterConfigurationNotFoundError();
    const configuration = toConfiguration(row);
    await appendAuditEvent(tx, {
      eventType: 'ADAPTER_CONFIGURATION_CHANGED',
      action: 'SET_ADAPTER_ROUTING',
      targetType: 'ProviderAdapterConfiguration',
      targetId: configuration.adapterConfigurationId,
      aggregateType: 'ProviderAdapterConfiguration',
      aggregateId: configuration.adapterConfigurationId,
      tenantId: input.tenantId,
      actorType: 'SUAS_ADMIN',
      actorId: input.actorId,
      payload: {
        adapter_id: input.adapterId,
        capability: input.capability,
        coverage_counties: [...input.coverageCounties],
        routing_priority: input.routingPriority,
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return withCatalog(config, configuration);
  });
}
