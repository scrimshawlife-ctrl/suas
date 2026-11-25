/**
 * Review 2026-11-24 (#369): shared rate-limit state keeps a hash of the subject, never the email
 * or phone itself, and one subject still shares one counter.
 */

import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeRateLimit, rateLimitSubjectKey } from '../../src/auth/rate-limit.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';

const pool: Pool = createTestPool();
const POLICY = { bucket: 'auth.challenge.issue', limit: 2, windowSeconds: 900 };

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

describe('rate-limit subjects', () => {
  it('stores a hash of the address, not the address, and counts it once', async () => {
    const address = 'rate-subject@example.invalid';
    expect((await consumeRateLimit(pool, POLICY, address)).allowed).toBe(true);
    expect((await consumeRateLimit(pool, POLICY, address)).allowed).toBe(true);
    expect((await consumeRateLimit(pool, POLICY, address)).allowed).toBe(false);

    const rows = await pool.query<{ subject: string; count: number }>(
      'SELECT subject, count FROM auth_rate_limits',
    );
    expect(rows.rows).toEqual([{ subject: rateLimitSubjectKey(address), count: 3 }]);
    expect(rows.rows[0]?.subject).not.toContain('rate-subject');
  });

  it('matches the SQL form the LOCAL demo helper computes', async () => {
    const { rows } = await pool.query<{ key: string }>(
      `SELECT 'sha256:' || encode(sha256(convert_to($1, 'UTF8')), 'hex') AS key`,
      ['demo@example.invalid'],
    );
    expect(rows[0]?.key).toBe(rateLimitSubjectKey('demo@example.invalid'));
  });
});
