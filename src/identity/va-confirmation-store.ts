/**
 * VA confirmation attempts: the `veteran_verifications` rows behind the request gate
 * (suas-specs #72 R9.1, proposal; D035_VA_CONFIRMATION_ADAPTER.md §9, §12).
 *
 * Each attempt is one settled `VA_VETERAN_STATUS` row with only bounded result fields;
 * earlier results are kept. The newest settled row is the person's standing, except that
 * a REVOKED row (a SUAS act) wins over every attempt. Rows from the older OAuth sandbox
 * track have no `settled_at`, so they never open the gate.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/store.js';
import {
  VA_CONFIRMATION_CONTRACT_VERSION,
  VA_CONFIRMATION_PROJECTION_ID,
  type VaConfirmationFailureClass,
  type VaConfirmationProjection,
  type VeteranConfirmationPort,
} from './va-confirmation.js';
import type { VaNotConfirmedReason, VeteranVerificationStatus } from './veteran-verification.js';

/** R9.1 attempt limit: at most this many attempts per person per rolling 24 hours. */
export const VA_CONFIRMATION_MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_HOURS = 24;

export interface VeteranConfirmationStanding {
  readonly status: VeteranVerificationStatus;
  readonly notConfirmedReason: VaNotConfirmedReason | undefined;
  readonly verifiedAt: Date | undefined;
}

interface StandingRow {
  status: VeteranVerificationStatus;
  not_confirmed_reason: VaNotConfirmedReason | null;
  verified_at: Date | null;
}

const toStanding = (row: StandingRow): VeteranConfirmationStanding => ({
  status: row.status,
  notConfirmedReason: row.not_confirmed_reason ?? undefined,
  verifiedAt: row.verified_at ?? undefined,
});

/**
 * The person's standing: any REVOKED row, else the newest settled attempt. A revocation
 * therefore cannot be outrun by an attempt that settles after it.
 */
export async function readVeteranConfirmation(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<VeteranConfirmationStanding | undefined> {
  const result = await db.query<StandingRow>(
    `SELECT status, not_confirmed_reason, verified_at FROM veteran_verifications
     WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
       AND (settled_at IS NOT NULL OR status = 'REVOKED')
     ORDER BY (status = 'REVOKED') DESC, settled_at DESC NULLS LAST, created_at DESC,
              verification_id DESC
     LIMIT 1`,
    [tenantId, userId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toStanding(row);
}

/** True when the person's current standing is a VERIFIED VA confirmation. */
export async function hasConfirmedVeteranStatus(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  return (await readVeteranConfirmation(db, tenantId, userId))?.status === 'VERIFIED';
}

export class VeteranConfirmationAttemptLimitError extends Error {
  readonly code = 'VERIFICATION_ATTEMPT_LIMIT';
  readonly httpStatus = 429;

  constructor(readonly retryAfterSeconds: number) {
    super(
      `At most ${VA_CONFIRMATION_MAX_ATTEMPTS} confirmation attempts are allowed in 24 hours. Try again later.`,
    );
    this.name = 'VeteranConfirmationAttemptLimitError';
  }
}

/** A revoked standing takes no new attempt. Who may lift a revocation is not decided. */
export class VeteranConfirmationRevokedError extends Error {
  readonly code = 'VERIFICATION_REVOKED';
  readonly httpStatus = 403;

  constructor() {
    super('This Veteran confirmation was revoked. A new attempt is not possible.');
    this.name = 'VeteranConfirmationRevokedError';
  }
}

/** Throws the attempt-limit error when the rolling window is full. */
async function assertAttemptAllowed(db: Queryable, tenantId: string, userId: string) {
  const result = await db.query<{ attempts: number; retry_after: number | null }>(
    `SELECT count(*)::int AS attempts,
            ceil(extract(epoch FROM min(created_at) + make_interval(hours => $3) - now()))::int
              AS retry_after
       FROM veteran_verifications
      WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
        AND settled_at IS NOT NULL
        AND created_at > now() - make_interval(hours => $3)`,
    [tenantId, userId, ATTEMPT_WINDOW_HOURS],
  );
  const row = result.rows[0];
  if (row !== undefined && row.attempts >= VA_CONFIRMATION_MAX_ATTEMPTS) {
    throw new VeteranConfirmationAttemptLimitError(Math.max(1, row.retry_after ?? 1));
  }
}

export interface ConfirmVeteranInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly projection: VaConfirmationProjection;
  readonly correlationId?: string;
}

/**
 * One attempt: re-read the standing, check the limit, ask the port once, record the
 * settled row and its two Audit Events. Call inside a transaction; a per-person lock
 * serializes attempts, so a REVOKED or VERIFIED standing found under it takes no new
 * attempt (`verificationId` is then undefined). Audit payloads carry status, reason and
 * class only.
 */
export async function confirmVeteranStatus(
  tx: Queryable,
  port: VeteranConfirmationPort,
  input: ConfirmVeteranInput,
): Promise<{ verificationId: string | undefined; standing: VeteranConfirmationStanding }> {
  const { tenantId, userId } = input;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `va-confirmation:${tenantId}:${userId}`,
  ]);
  const current = await readVeteranConfirmation(tx, tenantId, userId);
  if (current?.status === 'REVOKED') throw new VeteranConfirmationRevokedError();
  if (current?.status === 'VERIFIED') return { verificationId: undefined, standing: current };
  await assertAttemptAllowed(tx, tenantId, userId);

  const verificationId = randomUUID();
  const audit = (eventType: string, action: string, payload: Record<string, string | null>) =>
    appendAuditEvent(tx, {
      eventType,
      action,
      targetType: 'VeteranVerification',
      targetId: verificationId,
      aggregateType: 'User',
      aggregateId: userId,
      tenantId,
      actorType: 'USER',
      actorId: userId,
      payload,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

  await audit('VETERAN_VERIFICATION_ATTEMPTED', 'ATTEMPT_VETERAN_VERIFICATION', {});
  const result = await port.confirm(input.projection);
  const failureClass: VaConfirmationFailureClass | null = result.failureClass ?? null;

  const inserted = await tx.query<StandingRow>(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        verified_at, not_confirmed_reason, provider_environment, projection_id, failure_class,
        settled_at)
     VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', $4::suas_veteran_verification_status, $5, $6,
             CASE WHEN $4::suas_veteran_verification_status = 'VERIFIED' THEN now() END,
             $7::suas_va_not_confirmed_reason, $8, $9, $10, now())
     RETURNING status, not_confirmed_reason, verified_at`,
    [
      verificationId,
      tenantId,
      userId,
      result.status,
      port.providerEnvironment === 'NONE' ? 'SUAS' : 'VA',
      VA_CONFIRMATION_CONTRACT_VERSION,
      result.notConfirmedReason ?? null,
      port.providerEnvironment,
      VA_CONFIRMATION_PROJECTION_ID,
      failureClass,
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('VA confirmation attempt was not recorded.');

  await audit('VETERAN_VERIFICATION_SETTLED', 'SETTLE_VETERAN_VERIFICATION', {
    status: result.status,
    not_confirmed_reason: result.notConfirmedReason ?? null,
    failure_class: failureClass,
  });
  return { verificationId, standing: toStanding(row) };
}
