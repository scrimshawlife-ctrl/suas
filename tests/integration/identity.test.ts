/**
 * Identity and tenancy integration evidence (requires PostgreSQL).
 *
 * SUAS-specs DOMAIN_MODEL.md §2; DATA_MODEL.md §2, §14 rule 1;
 * AUTH.md §6; ADMIN.md §1-§2; V1_PROJECT_PLAN.md §2.1; SECURITY.md §2 (tenant isolation, soft-delete).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createUser,
  findUserByDestination,
  findUserById,
  grantSuasAdmin,
  isSuasAdmin,
  listBorderingCounties,
  NoEnrolledChannelError,
  revokeSuasAdmin,
  setUserCounty,
  setUserStatus,
  softDeleteUser,
  UserTerminalError,
} from '../../src/identity/index.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { syntheticEmail, syntheticPhone } from '../../src/testing/fixture-boundary.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function activeUser(tenantId: string, local = 'veteran') {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${local}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

describe('DOMAIN_MODEL.md §2 — users', () => {
  it('creates a user with an enrolled channel', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail('veteran-01'),
      phone: syntheticPhone(1),
    });
    expect(user.status).toBe('INVITED');
    expect(user.tenantId).toBe(tenantId);
  });

  it('refuses a user with no enrolled channel', async () => {
    await expect(createUser(pool, { tenantId: syntheticTenantId() })).rejects.toThrow(
      NoEnrolledChannelError,
    );
  });

  it('treats contact identifiers as unique within a tenant', async () => {
    const tenantId = syntheticTenantId();
    const email = syntheticEmail('shared');
    await createUser(pool, { tenantId, email });
    await expect(createUser(pool, { tenantId, email })).rejects.toThrow();
  });

  it('allows the same address in a different tenant', async () => {
    const email = syntheticEmail('same-person');
    await createUser(pool, { tenantId: syntheticTenantId(), email });
    const other = await createUser(pool, { tenantId: syntheticTenantId(), email });
    expect(other.email).toBe(email.toLowerCase());
  });

  it('does not match a lookup across tenants', async () => {
    const email = syntheticEmail('scoped');
    const tenantA = syntheticTenantId();
    await createUser(pool, { tenantId: tenantA, email });

    expect(await findUserByDestination(pool, tenantA, email)).toBeDefined();
    expect(await findUserByDestination(pool, syntheticTenantId(), email)).toBeUndefined();
  });

  it('matches a destination regardless of casing', async () => {
    const tenantId = syntheticTenantId();
    await createUser(pool, { tenantId, email: syntheticEmail('CaseTest') });
    expect(await findUserByDestination(pool, tenantId, 'CASETEST@EXAMPLE.INVALID')).toBeDefined();
  });

  it('soft-deletes rather than removing the row, so historical actor ids resolve', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);

    expect(await softDeleteUser(pool, tenantId, user.userId)).toBe(true);
    expect(await findUserById(pool, tenantId, user.userId)).toBeUndefined();

    const raw = await pool.query('SELECT status, deleted_at FROM users WHERE user_id = $1', [
      user.userId,
    ]);
    expect(raw.rows[0]).toMatchObject({ status: 'REVOKED' });
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
  });

  it('moves through the released lifecycle', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, { tenantId, email: syntheticEmail('lifecycle') });
    expect((await setUserStatus(pool, tenantId, user.userId, 'ACTIVE'))?.status).toBe('ACTIVE');
    expect((await setUserStatus(pool, tenantId, user.userId, 'SUSPENDED'))?.status).toBe(
      'SUSPENDED',
    );
    expect((await setUserStatus(pool, tenantId, user.userId, 'REVOKED'))?.status).toBe('REVOKED');
  });

  it('refuses to reactivate a REVOKED user (terminal)', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    await setUserStatus(pool, tenantId, user.userId, 'REVOKED');
    await expect(setUserStatus(pool, tenantId, user.userId, 'ACTIVE')).rejects.toThrow(
      UserTerminalError,
    );
    expect((await findUserById(pool, tenantId, user.userId))?.status).toBe('REVOKED');
  });

  it('will not change a user in another tenant', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    expect(await setUserStatus(pool, syntheticTenantId(), user.userId, 'REVOKED')).toBeUndefined();
  });
});

describe('V1_PROJECT_PLAN.md §2.1 — county', () => {
  it('has no county until the person picks one', async () => {
    const user = await activeUser(syntheticTenantId());
    expect(user.county).toBeUndefined();
  });

  it('stores a launch county and lets the person change it', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail('county-01'),
      county: 'SANTA_CLARA',
    });
    expect(user.county).toBe('SANTA_CLARA');

    const moved = await setUserCounty(pool, tenantId, user.userId, 'ALAMEDA');
    expect(moved?.county).toBe('ALAMEDA');
  });

  it('refuses a county outside the launch list', async () => {
    await expect(
      pool.query(`INSERT INTO users (user_id, tenant_id, county) VALUES ($1, $2, 'MARIN')`, [
        randomUUID(),
        syntheticTenantId(),
      ]),
    ).rejects.toThrow();
  });

  it('seeds bordering counties in both directions, water borders included', async () => {
    expect(await listBorderingCounties(pool, 'SANTA_CLARA')).toEqual([
      'SAN_MATEO',
      'ALAMEDA',
      'SANTA_CRUZ',
      'SAN_BENITO',
      'MERCED',
      'STANISLAUS',
    ]);
    // San Mateo and Alameda meet only across San Francisco Bay; a water border counts.
    expect(await listBorderingCounties(pool, 'SAN_MATEO')).toEqual([
      'SANTA_CLARA',
      'ALAMEDA',
      'SANTA_CRUZ',
    ]);
    expect(await listBorderingCounties(pool, 'ALAMEDA')).toContain('SAN_MATEO');
    // Alameda borders San Joaquin, not Stanislaus. 0013's Wikipedia source does not
    // list that pair; 0019 removes it. Santa Clara–Stanislaus stays.
    expect(await listBorderingCounties(pool, 'ALAMEDA')).not.toContain('STANISLAUS');
    // Symmetry: every row has its mirror.
    const unmatched = await pool.query(
      `SELECT 1 FROM county_adjacency a
        WHERE NOT EXISTS (SELECT 1 FROM county_adjacency b
                           WHERE b.county = a.adjacent_county AND b.adjacent_county = a.county)`,
    );
    expect(unmatched.rowCount).toBe(0);
  });

  it('stores the widening delay as a setting, 30 minutes by default', async () => {
    const result = await pool.query<{ value: number }>(
      `SELECT value FROM app_settings WHERE setting_key = 'widening_delay_minutes'`,
    );
    expect(result.rows[0]?.value).toBe(30);
  });
});

describe('AUTH.md §6, ADMIN.md §1 — the global SUAS-admin role', () => {
  it('grants and revokes explicitly, with the granting actor recorded', async () => {
    const tenantId = syntheticTenantId();
    const admin = await activeUser(tenantId, 'admin');
    const grantee = await activeUser(tenantId, 'grantee');

    const grant = await grantSuasAdmin(pool, grantee.userId, admin.userId);
    expect(grant.grantedBy).toBe(admin.userId);
    expect(await isSuasAdmin(pool, grantee.userId)).toBe(true);

    expect(await revokeSuasAdmin(pool, grantee.userId, admin.userId)).toBe(true);
    expect(await isSuasAdmin(pool, grantee.userId)).toBe(false);
  });

  it('allows at most one active grant per user', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    await grantSuasAdmin(pool, user.userId, undefined);
    await expect(grantSuasAdmin(pool, user.userId, undefined)).rejects.toThrow();
  });

  it('stops conferring the role when the user is no longer active', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    await grantSuasAdmin(pool, user.userId, undefined);

    await setUserStatus(pool, tenantId, user.userId, 'SUSPENDED');
    expect(await isSuasAdmin(pool, user.userId)).toBe(false);
  });

  it('is not conferred by being a signed-in person', async () => {
    const tenantId = syntheticTenantId();
    const user = await activeUser(tenantId);
    expect(await isSuasAdmin(pool, user.userId)).toBe(false);
  });
});
