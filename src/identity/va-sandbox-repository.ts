import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import type { VeteranVerificationResult } from './veteran-verification.js';

export function vaSafeHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashesMatch(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(vaSafeHash(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface StoredVaOAuthTransaction {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly redirectUri: string;
  readonly codeVerifierHash: string;
}

type TransactionRow = StoredVaOAuthTransaction;

/** Persist only irrecoverable state/verifier hashes and opaque UUID ownership. */
export async function createVaOAuthTransactionRecord(
  db: Queryable,
  input: {
    tenantId: string;
    userId: string;
    state: string;
    codeVerifier: string;
    redirectUri: string;
    expiresAt: Date;
  },
): Promise<string> {
  const transactionId = randomUUID();
  await db.query(
    `INSERT INTO va_oauth_transactions
       (transaction_id, tenant_id, user_id, state_hash, code_verifier_hash, redirect_uri, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      transactionId,
      input.tenantId,
      input.userId,
      vaSafeHash(input.state),
      vaSafeHash(input.codeVerifier),
      input.redirectUri,
      input.expiresAt,
    ],
  );
  return transactionId;
}

/** Atomically consume a non-expired transaction. A replay returns undefined. */
export async function consumeVaOAuthTransaction(
  db: Queryable,
  input: { state: string; tenantId: string; userId: string },
): Promise<StoredVaOAuthTransaction | undefined> {
  const result = await db.query<TransactionRow>(
    `UPDATE va_oauth_transactions
       SET consumed_at = now()
     WHERE state_hash = $1
       AND tenant_id = $2
       AND user_id = $3
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING transaction_id AS "transactionId", tenant_id AS "tenantId", user_id AS "userId",
               redirect_uri AS "redirectUri", code_verifier_hash AS "codeVerifierHash"`,
    [vaSafeHash(input.state), input.tenantId, input.userId],
  );
  return result.rows[0];
}

export async function recordVaSandboxVerification(
  db: Queryable,
  input: {
    tenantId: string;
    userId: string;
    result: VeteranVerificationResult;
  },
): Promise<string> {
  const verificationId = randomUUID();
  await db.query(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        verified_at, not_confirmed_reason)
     VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', $4, 'VA', $5, $6, $7)`,
    [
      verificationId,
      input.tenantId,
      input.userId,
      input.result.status,
      input.result.sourceContractVersion,
      input.result.status === 'VERIFIED' ? new Date() : null,
      input.result.notConfirmedReason ?? null,
    ],
  );
  return verificationId;
}
