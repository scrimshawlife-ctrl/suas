/**
 * Test helpers: give a synthetic user a VERIFIED VA Veteran Confirmation (the request
 * gate, suas-specs #72 R9.1 proposal), as the fixture adapter would record it, and a county
 * when they have none, so tests of gated routes can reach the behavior under test.
 * A county the test already chose is never overwritten.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createUser, type CreateUserInput, type User } from '../../src/identity/index.js';

export async function markVerifiedVeteran(
  pool: Pool,
  tenantId: string,
  userId: string,
  county: string | null = 'SANTA_CLARA',
): Promise<void> {
  await pool.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        verified_at, provider_environment, projection_id, settled_at)
     VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'VERIFIED', 'SUAS', 'test', now(), 'NONE',
             'VA_CONFIRMATION_V1_REQUIRED_ONLY', now())`,
    [randomUUID(), tenantId, userId],
  );
  if (county !== null) {
    await pool.query(
      `UPDATE users SET county = COALESCE(county, $3) WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId, county],
    );
  }
}

/** `createUser`, then a VERIFIED confirmation: a requester who can use every gated route. */
export async function createVerifiedUser(pool: Pool, input: CreateUserInput): Promise<User> {
  const user = await createUser(pool, input);
  await markVerifiedVeteran(pool, user.tenantId, user.userId);
  return user;
}
