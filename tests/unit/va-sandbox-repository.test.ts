import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../src/db/transaction.js';
import {
  consumeVaOAuthTransaction,
  createVaOAuthTransactionRecord,
  hashesMatch,
  recordVaSandboxVerification,
  vaSafeHash,
} from '../../src/identity/va-sandbox-repository.js';

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function queryRecorder(rows: readonly unknown[] = []) {
  const calls: Call[] = [];
  return {
    calls,
    db: {
      query: <T>(sql: string, values: readonly unknown[]) => {
        calls.push({ sql, values });
        return Promise.resolve({ rows: rows as T[], rowCount: rows.length });
      },
    } as unknown as Queryable,
  };
}

describe('VA sandbox OAuth persistence', () => {
  it('persists only SHA-256 state and verifier hashes', async () => {
    const recorder = queryRecorder();
    await createVaOAuthTransactionRecord(recorder.db, {
      tenantId: 'tenant',
      userId: 'user',
      state: 'state-secret',
      codeVerifier: 'verifier-secret',
      redirectUri: 'https://local.example/auth/va/callback',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });

    const call = recorder.calls[0]!;
    expect(call.sql).toContain('INSERT INTO va_oauth_transactions');
    expect(call.values).toContain(vaSafeHash('state-secret'));
    expect(call.values).toContain(vaSafeHash('verifier-secret'));
    expect(call.values).not.toContain('state-secret');
    expect(call.values).not.toContain('verifier-secret');
  });

  it('atomically consumes a live transaction and hashes supplied state', async () => {
    const row = {
      transactionId: 'transaction',
      tenantId: 'tenant',
      userId: 'user',
      redirectUri: 'https://local.example/auth/va/callback',
      codeVerifierHash: vaSafeHash('verifier'),
    };
    const recorder = queryRecorder([row]);

    await expect(
      consumeVaOAuthTransaction(recorder.db, {
        state: 'state',
        tenantId: 'tenant',
        userId: 'user',
      }),
    ).resolves.toEqual(row);
    expect(recorder.calls[0]?.sql).toContain('tenant_id = $2');
    expect(recorder.calls[0]?.sql).toContain('user_id = $3');
    expect(recorder.calls[0]?.sql).toContain('consumed_at IS NULL');
    expect(recorder.calls[0]?.sql).toContain('expires_at > now()');
    expect(recorder.calls[0]?.values).toEqual([vaSafeHash('state'), 'tenant', 'user']);
  });

  it('records a normalized result without provider tokens or raw payloads', async () => {
    const recorder = queryRecorder();
    await recordVaSandboxVerification(recorder.db, {
      tenantId: 'tenant',
      userId: 'user',
      result: {
        status: 'NOT_CONFIRMED',
        notConfirmedReason: 'NOT_TITLE_38',
        sourceContractVersion: 'VA_SERVICE_HISTORY_ELIGIBILITY_STATUS_ONLY',
      },
    });

    const call = recorder.calls[0]!;
    expect(call.sql).toContain('INSERT INTO veteran_verifications');
    expect(call.values).toContain('NOT_CONFIRMED');
    expect(call.values).toContain('NOT_TITLE_38');
    expect(call.sql).not.toContain('access_token');
    expect(call.sql).not.toContain('raw_payload');
  });

  it('compares state-safe material with a timing-safe hash check', () => {
    expect(hashesMatch('value', vaSafeHash('value'))).toBe(true);
    expect(hashesMatch('other', vaSafeHash('value'))).toBe(false);
  });
});
