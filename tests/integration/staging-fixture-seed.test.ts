/**
 * R11.5: the migrate Lambda's `seed-staging-fixtures` action against a real database.
 * It seeds the registry's users and the fixture Resources once, refuses outside STAGING,
 * and refuses a non-synthetic or unregistered address before writing anything.
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { handler } from '../../src/aws/migrate-lambda.js';
import { STAGING_FIXTURE_SOURCE_LINK } from '../../src/staging/fixture-seed.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { testDatabaseUrl, validEnv } from '../helpers/env.js';

const pool = new Pool({ connectionString: testDatabaseUrl(), max: 2 });

afterEach(() => {
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await pool.end();
});

function useEnv(overrides: Record<string, string>): void {
  for (const [key, value] of Object.entries(validEnv(overrides))) {
    if (value !== undefined) vi.stubEnv(key, value);
  }
}

function stagingFor(tenantId: string, userIds: readonly string[]): void {
  useEnv({
    SUAS_ENV: 'STAGING',
    SUAS_PUBLIC_SIGN_UP: 'disabled',
    SUAS_ID_VERIFICATION_MODE: 'disabled',
    SUAS_STAGING_FIXTURE_REGISTRY: userIds.map((id) => `${tenantId}:${id}`).join(','),
  });
}

async function countsFor(tenantId: string): Promise<{ users: number; resources: number }> {
  const users = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM users WHERE tenant_id = $1',
    [tenantId],
  );
  const resources = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM resources WHERE tenant_id = $1',
    [tenantId],
  );
  return { users: users.rows[0]?.n ?? -1, resources: resources.rows[0]?.n ?? -1 };
}

describe('seed-staging-fixtures', () => {
  it('creates the registry users and published fixture Resources once', async () => {
    const tenantId = randomUUID();
    const [veteran, helper] = [randomUUID(), randomUUID()];
    stagingFor(tenantId, [veteran, helper]);
    const event = {
      action: 'seed-staging-fixtures',
      fixtures: [
        { user_id: veteran, email: syntheticEmail(`fixture-${veteran.slice(0, 8)}`) },
        { user_id: helper, email: syntheticEmail(`fixture-${helper.slice(0, 8)}`) },
      ],
    };

    const first = await handler(event);
    expect(first).toMatchObject({
      action: 'seed-staging-fixtures',
      environment: 'STAGING',
      users_created: 2,
      users_existing: 0,
      resources_published: 4,
      resources_existing: 0,
      registry: `${tenantId}:${veteran},${tenantId}:${helper}`,
    });
    expect(JSON.stringify(first)).not.toContain('@');

    const users = await pool.query<{ user_id: string; status: string; county: string }>(
      'SELECT user_id, status, county FROM users WHERE tenant_id = $1 AND user_id = ANY($2)',
      [tenantId, [veteran, helper]],
    );
    expect(users.rows).toHaveLength(2);
    for (const row of users.rows)
      expect(row).toMatchObject({ status: 'ACTIVE', county: 'SANTA_CLARA' });

    const published = await pool.query<{ active: boolean; verified: boolean; source: string }>(
      `SELECT r.active, r.last_verified_at IS NOT NULL AS verified, r.verification_source AS source
         FROM resource_drafts d JOIN resources r ON r.resource_id = d.published_resource_id
        WHERE d.tenant_id = $1 AND d.status = 'PUBLISHED'`,
      [tenantId],
    );
    expect(published.rows).toHaveLength(4);
    for (const row of published.rows) {
      expect(row).toEqual({ active: true, verified: true, source: STAGING_FIXTURE_SOURCE_LINK });
    }
    // No passed ID scan is seeded (VETERAN_VERIFICATION.md §1.1, D-052).
    const scans = await pool.query('SELECT 1 FROM veteran_verifications WHERE tenant_id = $1', [
      tenantId,
    ]);
    expect(scans.rowCount).toBe(0);

    const before = await countsFor(tenantId);
    const again = await handler(event);
    expect(again).toMatchObject({
      users_created: 0,
      users_existing: 2,
      resources_published: 0,
      resources_existing: 4,
    });
    expect(await countsFor(tenantId)).toEqual(before);
  });

  it('refuses outside STAGING', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    useEnv({ SUAS_STAGING_FIXTURE_REGISTRY: `${tenantId}:${userId}` });
    await expect(
      handler({
        action: 'seed-staging-fixtures',
        fixtures: [{ user_id: userId, email: syntheticEmail('fixture-test-env') }],
      }),
    ).rejects.toThrow(/STAGING only/);
    expect(await countsFor(tenantId)).toEqual({ users: 0, resources: 0 });
  });

  it('refuses a non-synthetic address, and a user missing from the registry, before any write', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    stagingFor(tenantId, [userId]);
    await expect(
      handler({
        action: 'seed-staging-fixtures',
        fixtures: [{ user_id: userId, email: 'person@gmail.com' }],
      }),
    ).rejects.toThrow(/not synthetic/);
    await expect(
      handler({
        action: 'seed-staging-fixtures',
        fixtures: [{ user_id: randomUUID(), email: syntheticEmail('fixture-unlisted') }],
      }),
    ).rejects.toThrow(/not in SUAS_STAGING_FIXTURE_REGISTRY/);
    expect(await countsFor(tenantId)).toEqual({ users: 0, resources: 0 });
  });

  it('refuses an unknown action', async () => {
    await expect(handler({ action: 'drop-everything' })).rejects.toThrow(/Unknown action/);
  });
});
