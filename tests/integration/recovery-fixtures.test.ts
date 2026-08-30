import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RECOVERY_FIXTURE_VERSION,
  seedRecoveryFixtures,
} from '../../src/testing/recovery-fixtures.js';
import { createTestPool } from '../helpers/db.js';

describe('synthetic recovery fixture dataset', () => {
  let pool: Pool;
  const tenantId = randomUUID();
  const now = new Date('2026-08-30T12:00:00.000Z');

  beforeAll(() => {
    pool = createTestPool();
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM job_outbox WHERE tenant_id = $1`, [tenantId]);
    await pool.end();
  });

  it('installs every durable lifecycle state deterministically and idempotently', async () => {
    const first = await seedRecoveryFixtures(pool, { tenantId, now });
    const second = await seedRecoveryFixtures(pool, { tenantId, now });

    expect(first).toEqual(second);
    expect(first).toEqual({
      version: RECOVERY_FIXTURE_VERSION,
      tenantId,
      total: 7,
      statuses: { PENDING: 3, LEASED: 2, SUCCEEDED: 1, DEAD_LETTER: 1 },
    });

    const rows = await pool.query<{
      job_type: string;
      status: string;
      attempts: number;
      max_attempts: number;
      payload: { fixture: string; state: string };
    }>(
      `SELECT job_type, status, attempts, max_attempts, payload
       FROM job_outbox
       WHERE tenant_id = $1 AND job_type LIKE 'synthetic.recovery.%'
       ORDER BY job_type`,
      [tenantId],
    );

    expect(rows.rowCount).toBe(7);
    expect(rows.rows.every((row) => row.payload.fixture === RECOVERY_FIXTURE_VERSION)).toBe(true);
    expect(rows.rows.map((row) => row.job_type)).toEqual([
      'synthetic.recovery.dead_letter',
      'synthetic.recovery.leased_active',
      'synthetic.recovery.leased_expired',
      'synthetic.recovery.queued_due',
      'synthetic.recovery.retry_pending',
      'synthetic.recovery.scheduled',
      'synthetic.recovery.succeeded',
    ]);
  });

  it('makes only the due queued and expired-lease fixtures immediately reclaimable', async () => {
    await seedRecoveryFixtures(pool, { tenantId, now });
    const eligible = await pool.query<{ state: string }>(
      `SELECT payload->>'state' AS state
       FROM job_outbox
       WHERE tenant_id = $1
         AND run_at <= $2
         AND (
           status = 'PENDING'
           OR (status = 'LEASED' AND leased_until IS NOT NULL AND leased_until < $2)
         )
       ORDER BY payload->>'state'`,
      [tenantId, now.toISOString()],
    );

    expect(eligible.rows.map((row) => row.state)).toEqual(['leased_expired', 'queued_due']);
  });
});
