/**
 * Test helper: give a synthetic user a passed ID scan + selfie check (and, optionally,
 * a county) so tests of gated routes can reach the behavior under test.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export async function markVerifiedVeteran(
  pool: Pool,
  tenantId: string,
  userId: string,
  county: string | null = 'SANTA_CLARA',
): Promise<void> {
  await pool.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        verified_at)
     VALUES ($1, $2, $3, 'ID_SCAN_SELFIE', 'VERIFIED', 'SUAS', 'test', now())`,
    [randomUUID(), tenantId, userId],
  );
  if (county !== null) {
    await pool.query(`UPDATE users SET county = $3 WHERE tenant_id = $1 AND user_id = $2`, [
      tenantId,
      userId,
      county,
    ]);
  }
}
