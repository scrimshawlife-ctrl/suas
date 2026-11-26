/**
 * Review of #374, 2026-11-25: shared rate-limit state keeps a keyed, bucket-scoped HMAC of the
 * subject, never the address, and one subject still shares one counter.
 */

import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeRateLimit, rateLimitSubject } from '../../src/auth/rate-limit.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { TEST_SESSION_SECRET } from '../helpers/env.js';

const pool: Pool = createTestPool();
const POLICY = { bucket: 'auth.challenge.issue', limit: 2, windowSeconds: 900 };

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

describe('rate-limit subjects', () => {
  it('stores a keyed HMAC of the address, not the address, and counts it once', async () => {
    const address = 'rate-subject@example.invalid';
    const subject = rateLimitSubject(TEST_SESSION_SECRET, POLICY.bucket, address);
    expect((await consumeRateLimit(pool, POLICY, subject)).allowed).toBe(true);
    expect((await consumeRateLimit(pool, POLICY, subject)).allowed).toBe(true);
    expect((await consumeRateLimit(pool, POLICY, subject)).allowed).toBe(false);

    const rows = await pool.query<{ subject: string; count: number }>(
      'SELECT subject, count FROM auth_rate_limits',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.subject).toMatch(/^hmac1:[0-9a-f]{64}$/);
    expect(rows.rows[0]?.subject).not.toContain(address);
    expect(rows.rows[0]?.count).toBe(3);
  });

  it('folds an exhausted legacy plaintext counter into the keyed row, so it stays exhausted', async () => {
    // Review of #374, 2026-11-25: cutover must not restart a live window at 1.
    const address = 'cutover@example.invalid';
    await pool.query(
      `INSERT INTO auth_rate_limits (bucket, subject, window_start, count)
       VALUES ($1, $2, to_timestamp(floor(extract(epoch FROM now()) / $3) * $3), $4)`,
      [POLICY.bucket, address, POLICY.windowSeconds, POLICY.limit],
    );

    const subject = rateLimitSubject(TEST_SESSION_SECRET, POLICY.bucket, address);
    expect((await consumeRateLimit(pool, POLICY, subject)).allowed).toBe(false);

    const rows = await pool.query<{ subject: string; count: number }>(
      'SELECT subject, count FROM auth_rate_limits',
    );
    expect(rows.rows).toEqual([{ subject: subject.key, count: POLICY.limit + 1 }]);
    expect(rows.rows.some((row) => row.subject.includes(address))).toBe(false);
  });
});
