/**
 * The STAGING provision command emits the fixture registry the auth gate reads.
 * The artifact is identifiers only.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  provisionExplicitFixtures,
  STAGING_AUTH_TENANT_ID,
  stagingFixtureRegistryValue,
} from '../../src/cli/provision-staging-auth-users.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { testDatabaseUrl } from '../helpers/env.js';

const pool = new Pool({ connectionString: testDatabaseUrl(), max: 2 });

afterAll(async () => {
  await pool.end();
});

describe('STAGING fixture registry provisioning', () => {
  it('emits the persisted tenant and user ids and no secrets', async () => {
    const first = syntheticEmail(`provision-${randomUUID().slice(0, 8)}`);
    const second = syntheticEmail(`provision-${randomUUID().slice(0, 8)}`);
    const artifact = await provisionExplicitFixtures(pool, [first, second]);
    const registry = stagingFixtureRegistryValue(artifact);
    const printed = JSON.stringify({ registry });

    expect(artifact.principals).toHaveLength(2);
    expect(printed).not.toContain('@');
    expect(printed).not.toMatch(/secret|password/i);

    for (const [index, email] of [first, second].entries()) {
      const principal = artifact.principals[index];
      expect(principal).toBeDefined();
      const stored = await pool.query<{ user_id: string; tenant_id: string }>(
        `SELECT user_id, tenant_id FROM users
         WHERE tenant_id = $1 AND lower(email) = lower($2) AND deleted_at IS NULL`,
        [STAGING_AUTH_TENANT_ID, email],
      );
      expect(stored.rows).toHaveLength(1);
      expect(principal?.tenantId).toBe(stored.rows[0]?.tenant_id);
      expect(principal?.userId).toBe(stored.rows[0]?.user_id);
      expect(registry.split(',')).toContain(`${principal?.tenantId}:${principal?.userId}`);
    }

    const again = await provisionExplicitFixtures(pool, [first, second]);
    expect(stagingFixtureRegistryValue(again)).toBe(registry);
  });
});
