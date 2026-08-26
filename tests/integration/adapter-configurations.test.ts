/**
 * Admin adapter configuration (requires PostgreSQL).
 *
 * SUAS-specs ADMIN.md §3; PROVIDER_INTEGRATIONS.md §2 rules 8–10, §4.0.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  AdapterNotAcceptedError,
  AdapterSecretsMissingError,
  disableAdapterConfiguration,
  enableAdapterConfiguration,
  listAdapterConfigurations,
  ManualAdapterRequiredError,
  seedManualAdapterConfigurations,
  setAdapterRouting,
} from '../../src/fulfillment/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { validEnv } from '../helpers/env.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();
const config = loadConfig(validEnv());

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function actor(tenantId: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`admin-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

describe('seedManualAdapterConfigurations', () => {
  it('enables one manual adapter per MVP capability and is idempotent', async () => {
    const tenantId = syntheticTenantId();
    const first = await seedManualAdapterConfigurations(pool, tenantId);
    const second = await seedManualAdapterConfigurations(pool, tenantId);
    expect(first).toHaveLength(4);
    expect(second.map((row) => row.adapterConfigurationId).sort()).toEqual(
      first.map((row) => row.adapterConfigurationId).sort(),
    );
    expect(second.every((row) => row.enabled)).toBe(true);
    const listed = await listAdapterConfigurations(pool, config, tenantId);
    expect(listed.map((row) => `${row.capability}:${row.adapterId}`).sort()).toEqual([
      'FOOD:food-manual',
      'PEER_SUPPORT:peer-support-manual',
      'SHELTER:shelter-manual',
      'TRANSPORTATION:transportation-manual',
    ]);
  });
});

describe('enable / disable / routing', () => {
  it('refuses a food API adapter while D-019 is open', async () => {
    const tenantId = syntheticTenantId();
    const admin = await actor(tenantId);
    await expect(
      enableAdapterConfiguration(pool, config, {
        tenantId,
        adapterId: 'food-api',
        capability: 'FOOD',
        actorId: admin.userId,
      }),
    ).rejects.toBeInstanceOf(AdapterNotAcceptedError);
  });

  it('refuses transportation-api when secrets are missing', async () => {
    const tenantId = syntheticTenantId();
    const admin = await actor(tenantId);
    await expect(
      enableAdapterConfiguration(pool, config, {
        tenantId,
        adapterId: 'transportation-api',
        capability: 'TRANSPORTATION',
        actorId: admin.userId,
      }),
    ).rejects.toBeInstanceOf(AdapterSecretsMissingError);
  });

  it('enables transportation-api when secrets are configured, then disable preserves the row', async () => {
    const tenantId = syntheticTenantId();
    const admin = await actor(tenantId);
    const withSecrets = loadConfig(
      validEnv({
        SUAS_UBER_GUEST_RIDES_CLIENT_ID: 'client',
        SUAS_UBER_GUEST_RIDES_CLIENT_SECRET: 'secret',
      }),
    );
    const enabled = await enableAdapterConfiguration(pool, withSecrets, {
      tenantId,
      adapterId: 'transportation-api',
      capability: 'TRANSPORTATION',
      actorId: admin.userId,
      coverageCounties: ['santa-clara'],
      routingPriority: 10,
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.secretPresence).toBe('CONFIGURED');
    expect(enabled.coverageCounties).toEqual(['santa-clara']);

    const disabled = await disableAdapterConfiguration(pool, withSecrets, {
      tenantId,
      adapterId: 'transportation-api',
      capability: 'TRANSPORTATION',
      actorId: admin.userId,
    });
    expect(disabled.enabled).toBe(false);
    expect(disabled.adapterConfigurationId).toBe(enabled.adapterConfigurationId);

    const listed = await listAdapterConfigurations(pool, withSecrets, tenantId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.enabled).toBe(false);
  });

  it('refuses to disable a mandatory manual adapter', async () => {
    const tenantId = syntheticTenantId();
    const admin = await actor(tenantId);
    await seedManualAdapterConfigurations(pool, tenantId);
    await expect(
      disableAdapterConfiguration(pool, config, {
        tenantId,
        adapterId: 'shelter-manual',
        capability: 'SHELTER',
        actorId: admin.userId,
      }),
    ).rejects.toBeInstanceOf(ManualAdapterRequiredError);
  });

  it('updates coverage and priority without toggling enabled', async () => {
    const tenantId = syntheticTenantId();
    const admin = await actor(tenantId);
    await seedManualAdapterConfigurations(pool, tenantId);
    const updated = await setAdapterRouting(pool, config, {
      tenantId,
      adapterId: 'food-manual',
      capability: 'FOOD',
      actorId: admin.userId,
      coverageCounties: ['santa-clara', 'san-mateo'],
      routingPriority: 5,
    });
    expect(updated.enabled).toBe(true);
    expect(updated.coverageCounties).toEqual(['santa-clara', 'san-mateo']);
    expect(updated.routingPriority).toBe(5);
  });
});
