import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/transaction.js';
import {
  DEMO_SUBJECT_DOMAIN,
  assertLocalDemoDatabase,
  clearDemoSignInRateLimits,
} from '../../src/cli/demo-rate-limits.js';

const LOCAL_URL = 'postgresql://suas:suas@localhost:5432/suas_demo';

interface RecordedCall {
  text: string;
  values: readonly unknown[] | undefined;
}

function createFakeDb(rowCount: number | null = 2): { db: Queryable; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db: Queryable = {
    query(text, values) {
      calls.push({ text, values });
      const result = { rowCount, rows: [], command: 'DELETE', oid: 0, fields: [] };
      return Promise.resolve(result);
    },
  };
  return { db, calls };
}

describe('clearDemoSignInRateLimits', () => {
  it('deletes demo subjects on LOCAL with a loopback postgres URL', async () => {
    const { db, calls } = createFakeDb();

    const deleted = await clearDemoSignInRateLimits(db, {
      environment: 'LOCAL',
      databaseUrl: LOCAL_URL,
    });

    expect(deleted).toBe(2);
    expect(calls).toEqual([
      {
        text: 'DELETE FROM auth_rate_limits WHERE subject LIKE $1',
        values: [`%${DEMO_SUBJECT_DOMAIN}`],
      },
    ]);
  });

  it('allows the other loopback hosts on LOCAL', async () => {
    for (const host of ['127.0.0.1', '[::1]']) {
      const { db, calls } = createFakeDb();
      const deleted = await clearDemoSignInRateLimits(db, {
        environment: 'LOCAL',
        databaseUrl: `postgresql://suas:suas@${host}:5432/suas_demo`,
      });
      expect(deleted).toBe(2);
      expect(calls).toHaveLength(1);
    }
  });

  it('refuses STAGING, TEST, and PRODUCTION even with a loopback URL', async () => {
    for (const environment of ['STAGING', 'TEST', 'PRODUCTION']) {
      const { db, calls } = createFakeDb();
      await expect(
        clearDemoSignInRateLimits(db, { environment, databaseUrl: LOCAL_URL }),
      ).rejects.toThrow(/LOCAL/);
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses non-loopback, non-postgres, missing, and unparseable URLs', async () => {
    const urls: readonly (string | undefined)[] = [
      undefined,
      'postgresql://suas:suas@db.internal.invalid:5432/suas_demo',
      'postgresql://suas:suas@10.0.2.2:5432/suas_demo',
      'mysql://suas:suas@localhost:5432/suas_demo',
      'definitely not a url',
    ];

    for (const databaseUrl of urls) {
      const { db, calls } = createFakeDb();
      await expect(
        clearDemoSignInRateLimits(db, { environment: 'LOCAL', databaseUrl }),
      ).rejects.toThrow(Error);
      expect(calls).toHaveLength(0);
    }
  });

  it('never includes the password in the refusal message', () => {
    let message = '';
    try {
      assertLocalDemoDatabase(
        'LOCAL',
        'postgresql://suas:s3cret@db.internal.invalid:5432/suas_demo',
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain('s3cret');
    expect(message).toContain('db.internal.invalid');
  });
});
