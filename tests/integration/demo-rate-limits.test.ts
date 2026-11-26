/**
 * Review of #374, 2026-11-25: the LOCAL demo reset clears every seeded sign-in account's
 * counters, keyed or legacy plaintext, enrolled or not, and leaves other addresses alone.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { consumeRateLimit, rateLimitSubject } from '../../src/auth/rate-limit.js';
import { clearDemoSignInRateLimits } from '../../src/cli/demo-rate-limits.js';
import { createUser } from '../../src/identity/index.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { TEST_SESSION_SECRET, testDatabaseUrl } from '../helpers/env.js';

const pool: Pool = createTestPool();
const ISSUE = { bucket: 'auth.challenge.issue', limit: 3, windowSeconds: 900 };
const VERIFY = { bucket: 'auth.challenge.verify', limit: 5, windowSeconds: 900 };

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function seedKeyed(policy: typeof ISSUE, address: string): Promise<string> {
  const subject = rateLimitSubject(TEST_SESSION_SECRET, policy.bucket, address);
  await consumeRateLimit(pool, policy, subject);
  return subject.key;
}

describe('clearDemoSignInRateLimits on a real LOCAL database', () => {
  it('drops demo counters without a users join and keeps a non-demo control', async () => {
    await createUser(pool, {
      tenantId: randomUUID(),
      email: 'demo@example.invalid',
      status: 'ACTIVE',
    });
    await seedKeyed(ISSUE, 'demo@example.invalid');
    // newvet has no users row: the old join missed exactly this account.
    await seedKeyed(VERIFY, 'newvet@example.invalid');
    await pool.query(
      `INSERT INTO auth_rate_limits (bucket, subject, window_start, count)
       VALUES ('auth.challenge.issue', 'admin@example.invalid', now(), 3)`,
    );
    const control = await seedKeyed(ISSUE, 'control@elsewhere.invalid');

    const deleted = await clearDemoSignInRateLimits(pool, {
      environment: 'LOCAL',
      databaseUrl: testDatabaseUrl(),
      sessionSecret: TEST_SESSION_SECRET,
    });

    expect(deleted).toBe(3);
    const left = await pool.query<{ subject: string }>('SELECT subject FROM auth_rate_limits');
    expect(left.rows).toEqual([{ subject: control }]);
  });
});
