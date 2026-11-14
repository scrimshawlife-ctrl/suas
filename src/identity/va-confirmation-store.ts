/**
 * Veteran confirmation rows behind the request gate (suas-specs #72 R9.1, D035 §9, §12).
 *
 * Standing: a REVOKED row (a SUAS act) outranks everything; else a VERIFIED row of
 * VA_VETERAN_STATUS, MANUAL_REVIEW or SELF_ATTESTATION (in that order) opens the gate; else
 * the newest settled VA attempt is shown. A MANUAL_REVIEW VERIFIED row counts only while it
 * is that method's newest settled row, so an R10.1 REVIEW_ERROR revoke closes it without
 * rewriting history (VA_CONFIRMATION_FLOW §1.1 rule 1). Rows from the older OAuth sandbox track have no
 * `settled_at` and never count.
 *
 * A VA attempt is two short transactions with the VA call between them, so no database
 * lock is held across it (R9.1 D8): `beginVaAttempt` writes a PENDING row that is also the
 * idempotency record, and `settleVaAttempt` records the bounded result. Only the result,
 * a keyed request fingerprint and, for answers VA gave, a keyed identity hash are kept.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Queryable } from '../db/transaction.js';
import { withTransaction } from '../db/transaction.js';
import { appendAuditEvent } from '../events/store.js';
import { canonicalize } from '../idempotency/fingerprint.js';
import { CommandInProgressError, IdempotencyConflictError } from '../idempotency/run.js';
import { fingerprint, matchesStored, type FingerprintKeyring } from './fingerprint-keys.js';
import {
  VA_CONFIRMATION_CONTRACT_VERSION,
  VA_CONFIRMATION_PROJECTION_ID,
  type VaConfirmationFailureClass,
  type VaConfirmationProjection,
  type VaProviderEnvironment,
  type VeteranConfirmationResult,
} from './va-confirmation.js';
import { acquireVaCall, recordVaCallOutcome } from './va-outage-cooldown.js';
import {
  identityHash,
  identityHashCandidates,
  VaIdentityAlreadyVerifiedError,
} from './va-identity.js';
import type {
  VaNotConfirmedReason,
  VeteranVerificationMethod,
  VeteranVerificationStatus,
} from './veteran-verification.js';

/** R9.1 attempt limit: at most this many VA-answered attempts per person per rolling 24 hours. */
export const VA_CONFIRMATION_MAX_ATTEMPTS = 5;
/**
 * Outbound cap per person per rolling 24 hours (owner, suas #238, 2026-11-12). Like the 5
 * tries it never counts outages or VA 400s: the only UNAVAILABLE row it counts is an
 * identity conflict, which VA answered. So it counts the same rows as the 5-try limit, an
 * attempt in flight and conflicts included; that limit trips first and this is a backstop.
 */
export const VA_CONFIRMATION_MAX_CALLS = 20;
const ATTEMPT_WINDOW_HOURS = 24;
/** Idempotency records older than this are ignored (R9.1 D5). */
const IDEMPOTENCY_WINDOW_HOURS = 24;
/** A PENDING attempt older than this lost its process; it settles as a timeout. */
const STALE_PENDING_SECONDS = 120;

/** HMAC label for the confirm request fingerprint under SUAS_FINGERPRINT_KEY. */
export const VA_CONFIRMATION_FINGERPRINT_LABEL = 'suas/va-confirmation-request/v1';

/**
 * SUAS-side class for an attempt VA verified but refused because another account holds
 * the identity. It counts toward the limit (it caps probing) and is never the standing.
 */
export const IDENTITY_CONFLICT_CLASS = 'IDENTITY_CONFLICT';

export interface VeteranConfirmationStanding {
  readonly method: VeteranVerificationMethod;
  readonly status: VeteranVerificationStatus;
  readonly notConfirmedReason: VaNotConfirmedReason | undefined;
  readonly verifiedAt: Date | undefined;
  readonly failureClass: VaConfirmationFailureClass | undefined;
}

interface StandingRow {
  method: VeteranVerificationMethod;
  status: VeteranVerificationStatus;
  not_confirmed_reason: VaNotConfirmedReason | null;
  verified_at: Date | null;
  failure_class: VaConfirmationFailureClass | null;
}

const STANDING_COLUMNS = 'method, status, not_confirmed_reason, verified_at, failure_class';

const toStanding = (row: StandingRow): VeteranConfirmationStanding => ({
  method: row.method,
  status: row.status,
  notConfirmedReason: row.not_confirmed_reason ?? undefined,
  verifiedAt: row.verified_at ?? undefined,
  failureClass: row.failure_class ?? undefined,
});

/** The person's standing (see the module comment), or undefined before any row. */
export async function readVeteranConfirmation(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<VeteranConfirmationStanding | undefined> {
  const result = await db.query<StandingRow>(
    `SELECT ${STANDING_COLUMNS} FROM veteran_verifications v
     WHERE tenant_id = $1 AND user_id = $2
       AND (status = 'REVOKED'
            OR (status = 'VERIFIED' AND method = 'SELF_ATTESTATION')
            OR (status = 'VERIFIED' AND method = 'MANUAL_REVIEW' AND settled_at IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM veteran_verifications newer
                   WHERE newer.tenant_id = v.tenant_id AND newer.user_id = v.user_id
                     AND newer.method = 'MANUAL_REVIEW' AND newer.settled_at IS NOT NULL
                     AND (newer.settled_at, newer.created_at, newer.verification_id)
                         > (v.settled_at, v.created_at, v.verification_id)))
            OR (method = 'VA_VETERAN_STATUS' AND settled_at IS NOT NULL
                AND failure_class IS DISTINCT FROM '${IDENTITY_CONFLICT_CLASS}'))
     ORDER BY (status = 'REVOKED') DESC, (status = 'VERIFIED') DESC,
              CASE method WHEN 'VA_VETERAN_STATUS' THEN 0 WHEN 'MANUAL_REVIEW' THEN 1 ELSE 2 END,
              settled_at DESC NULLS LAST, created_at DESC, verification_id DESC
     LIMIT 1`,
    [tenantId, userId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toStanding(row);
}

/** True when the standing opens the request gate. */
export async function hasConfirmedVeteranStatus(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  return (await readVeteranConfirmation(db, tenantId, userId))?.status === 'VERIFIED';
}

/** True when VA itself verified the person: the confirm route then takes no attempt. */
export const isVaVerified = (standing: VeteranConfirmationStanding | undefined): boolean =>
  standing?.status === 'VERIFIED' && standing.method === 'VA_VETERAN_STATUS';

export class VeteranConfirmationAttemptLimitError extends Error {
  readonly code = 'VERIFICATION_ATTEMPT_LIMIT';
  readonly httpStatus = 429;

  constructor(
    readonly retryAfterSeconds: number,
    message = `At most ${VA_CONFIRMATION_MAX_ATTEMPTS} confirmation attempts are allowed in the last 24 hours. Try again later.`,
  ) {
    super(message);
    this.name = 'VeteranConfirmationAttemptLimitError';
  }
}

/** A revoked standing takes no new attempt or self-attestation. No lift path exists yet. */
export class VeteranConfirmationRevokedError extends Error {
  readonly code = 'VERIFICATION_REVOKED';
  readonly httpStatus = 403;

  constructor() {
    super('This Veteran confirmation was revoked. A new attempt is not possible.');
    this.name = 'VeteranConfirmationRevokedError';
  }
}

/** Serializes one person's confirmation writes; held only inside short transactions. */
const lockPerson = (tx: Queryable, tenantId: string, userId: string) =>
  tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`va-confirmation:${tenantId}:${userId}`]);

/**
 * The newest settled VA attempt behind the VA standing (identity conflicts left out), or
 * undefined before any. R10.1 offers the licence path only after a real NOT_CONFIRMED here.
 */
export async function readNewestVaAttempt(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<
  | {
      verificationId: string;
      status: VeteranVerificationStatus;
      reason: VaNotConfirmedReason | undefined;
    }
  | undefined
> {
  const result = await db.query<{
    verification_id: string;
    status: VeteranVerificationStatus;
    not_confirmed_reason: VaNotConfirmedReason | null;
  }>(
    `SELECT verification_id, status, not_confirmed_reason FROM veteran_verifications
      WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
        AND settled_at IS NOT NULL
        AND failure_class IS DISTINCT FROM '${IDENTITY_CONFLICT_CLASS}'
      ORDER BY settled_at DESC, created_at DESC, verification_id DESC
      LIMIT 1`,
    [tenantId, userId],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : {
        verificationId: row.verification_id,
        status: row.status,
        reason: row.not_confirmed_reason ?? undefined,
      };
}

/** True when the person has used all VA tries in the window (R10.1 L1.3 names this limit). */
export async function isAtVaAttemptLimit(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  return (await readAttemptCounts(db, tenantId, userId)).counted >= VA_CONFIRMATION_MAX_ATTEMPTS;
}

interface AttemptCounts {
  counted: number;
  retry_after: number | null;
}

/**
 * Only results VA answered (VERIFIED, NOT_CONFIRMED), an attempt in flight and identity
 * conflicts count; outages and refused requests (UNAVAILABLE) never do (R9.1 D3), for the
 * 5 tries and the 20-call cap alike. `retry_after` is when enough rows leave the window to
 * fall under the 5 tries again.
 */
async function readAttemptCounts(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<AttemptCounts> {
  const result = await db.query<AttemptCounts>(
    `WITH counted AS (
       SELECT created_at
         FROM veteran_verifications
        WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
          AND idempotency_key IS NOT NULL
          AND (status IN ('VERIFIED', 'NOT_CONFIRMED', 'PENDING')
               OR failure_class = '${IDENTITY_CONFLICT_CLASS}')
          AND created_at > now() - make_interval(hours => $3))
     SELECT count(*)::int AS counted,
            ceil(extract(epoch FROM
              (array_agg(created_at ORDER BY created_at))[greatest(count(*)::int - $4::int + 1, 1)]
              + make_interval(hours => $3) - now()))::int AS retry_after
       FROM counted`,
    [tenantId, userId, ATTEMPT_WINDOW_HOURS, VA_CONFIRMATION_MAX_ATTEMPTS],
  );
  return result.rows[0] ?? { counted: 0, retry_after: null };
}

/** Throws the attempt-limit error when the window is full; both limits answer 429. */
async function assertAttemptAllowed(db: Queryable, tenantId: string, userId: string) {
  const row = await readAttemptCounts(db, tenantId, userId);
  const retryAfter = Math.max(1, row.retry_after ?? 1);
  if (row.counted >= VA_CONFIRMATION_MAX_CALLS) {
    throw new VeteranConfirmationAttemptLimitError(
      retryAfter,
      `At most ${VA_CONFIRMATION_MAX_CALLS} VA checks are allowed in the last 24 hours. Try again later.`,
    );
  }
  if (row.counted >= VA_CONFIRMATION_MAX_ATTEMPTS) {
    throw new VeteranConfirmationAttemptLimitError(retryAfter);
  }
}

/** True when another account in the tenant holds this identity, under either key. */
async function identityHeldElsewhere(
  db: Queryable,
  keyring: FingerprintKeyring,
  tenantId: string,
  userId: string,
  projection: VaConfirmationProjection,
): Promise<boolean> {
  const candidates = identityHashCandidates(keyring, projection);
  const result = await db.query(
    `SELECT 1 FROM veteran_verifications
      WHERE tenant_id = $1 AND user_id <> $2 AND method = 'VA_VETERAN_STATUS'
        AND status = 'VERIFIED'
        AND (identity_hash, identity_key_id) IN (SELECT * FROM unnest($3::text[], $4::text[]))
      LIMIT 1`,
    [tenantId, userId, candidates.map((c) => c.hash), candidates.map((c) => c.keyId)],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface VaAttemptInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly projection: VaConfirmationProjection;
  readonly noticeVersion: string;
  readonly idempotencyKey: string;
  readonly providerEnvironment: VaProviderEnvironment;
  readonly correlationId?: string;
}

export type VaAttemptStart =
  /** Ask VA, then settle this attempt. */
  | { readonly kind: 'started'; readonly verificationId: string }
  /** No VA call: an earlier answer for this key, or the person is already VA verified. */
  | { readonly kind: 'answered'; readonly result: VeteranConfirmationStanding };

function auditor(tx: Queryable, input: VaAttemptInput, verificationId: string) {
  return (eventType: string, action: string, payload: Record<string, string | null>) =>
    appendAuditEvent(tx, {
      eventType,
      action,
      targetType: 'VeteranVerification',
      targetId: verificationId,
      aggregateType: 'User',
      aggregateId: input.userId,
      tenantId: input.tenantId,
      actorType: 'USER',
      actorId: input.userId,
      payload,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
}

interface KeyedRow extends StandingRow {
  request_fingerprint: string | null;
  fingerprint_key_id: string | null;
}

/**
 * Transaction 1: re-check the standing, resolve a retried key, check the limit, then
 * write the PENDING attempt. The identity is checked only at settle, after VA answers
 * VERIFIED: a check here would tell anyone with just a name and birth date that the
 * identity is verified on another account.
 */
export async function beginVaAttempt(
  pool: Pool,
  keyring: FingerprintKeyring,
  input: VaAttemptInput,
): Promise<VaAttemptStart> {
  const { tenantId, userId } = input;
  const requestValue = canonicalize({
    ...input.projection,
    notice_version: input.noticeVersion,
    actor_id: userId,
  });
  return withTransaction(pool, async (tx): Promise<VaAttemptStart> => {
    await lockPerson(tx, tenantId, userId);
    const current = await readVeteranConfirmation(tx, tenantId, userId);
    if (current?.status === 'REVOKED') throw new VeteranConfirmationRevokedError();
    if (current !== undefined && isVaVerified(current)) {
      return { kind: 'answered', result: current };
    }
    await tx.query(
      `UPDATE veteran_verifications
          SET status = 'UNAVAILABLE', failure_class = 'TIMEOUT', settled_at = clock_timestamp()
        WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
          AND status = 'PENDING' AND created_at < now() - make_interval(secs => $3)`,
      [tenantId, userId, STALE_PENDING_SECONDS],
    );

    // A retried key replays only an answer VA gave; an outage is retried as a new attempt.
    // A fingerprint under a key id this server no longer holds (a rotation) is a new
    // attempt too, never a 409.
    const earlier = await tx.query<KeyedRow>(
      `SELECT ${STANDING_COLUMNS}, request_fingerprint, fingerprint_key_id
         FROM veteran_verifications
        WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3
          AND status IN ('PENDING', 'VERIFIED', 'NOT_CONFIRMED')
          AND created_at > now() - make_interval(hours => $4)
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, userId, input.idempotencyKey, IDEMPOTENCY_WINDOW_HOURS],
    );
    const prior = earlier.rows[0];
    if (
      prior !== undefined &&
      prior.request_fingerprint !== null &&
      prior.fingerprint_key_id !== null
    ) {
      const same = matchesStored(keyring, VA_CONFIRMATION_FINGERPRINT_LABEL, requestValue, {
        hash: prior.request_fingerprint,
        keyId: prior.fingerprint_key_id,
      });
      if (same === false) {
        throw new IdempotencyConflictError(
          'This Idempotency-Key was already used for a different confirmation request.',
        );
      }
      if (same === true && prior.status === 'PENDING') {
        throw new CommandInProgressError(input.idempotencyKey, 'veteran confirmation');
      }
      if (same === true) return { kind: 'answered', result: toStanding(prior) };
    }
    const inFlight = await tx.query(
      `SELECT 1 FROM veteran_verifications
        WHERE tenant_id = $1 AND user_id = $2 AND method = 'VA_VETERAN_STATUS'
          AND status = 'PENDING'`,
      [tenantId, userId],
    );
    if ((inFlight.rowCount ?? 0) > 0) {
      throw new CommandInProgressError(input.idempotencyKey, 'veteran confirmation');
    }

    await assertAttemptAllowed(tx, tenantId, userId);

    const verificationId = randomUUID();
    const request = fingerprint(keyring, VA_CONFIRMATION_FINGERPRINT_LABEL, requestValue);
    await tx.query(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
          provider_environment, projection_id, notice_version, idempotency_key,
          request_fingerprint, fingerprint_key_id)
       VALUES ($1, $2, $3, 'VA_VETERAN_STATUS', 'PENDING', $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        verificationId,
        tenantId,
        userId,
        input.providerEnvironment === 'NONE' ? 'SUAS' : 'VA',
        VA_CONFIRMATION_CONTRACT_VERSION,
        input.providerEnvironment,
        VA_CONFIRMATION_PROJECTION_ID,
        input.noticeVersion,
        input.idempotencyKey,
        request.hash,
        request.keyId,
      ],
    );
    await auditor(tx, input, verificationId)(
      'VETERAN_VERIFICATION_ATTEMPTED',
      'ATTEMPT_VETERAN_VERIFICATION',
      { notice_version: input.noticeVersion },
    );
    return { kind: 'started', verificationId };
  });
}

/**
 * Transaction 2: record VA's result on the PENDING attempt. An answer VA gave keeps the
 * identity hash. A VERIFIED answer whose identity another account already holds (checked
 * under the current and previous key here, in the same transaction as the write; the
 * unique index catches a concurrent write under the current key) is settled as a counted
 * IDENTITY_CONFLICT and refused. A revocation or account deletion written during the VA
 * call is re-read under the lock: the attempt then settles with no identity hash and
 * `identity_released_at` set, so it cannot hold the identity, and REVOKED still outranks it.
 */
export async function settleVaAttempt(
  pool: Pool,
  keyring: FingerprintKeyring,
  input: VaAttemptInput,
  verificationId: string,
  result: VeteranConfirmationResult,
): Promise<VeteranConfirmationStanding> {
  const { tenantId, userId } = input;
  const answered = result.status === 'VERIFIED' || result.status === 'NOT_CONFIRMED';
  const identity = answered ? identityHash(keyring, input.projection) : undefined;

  const outcome = await withTransaction(pool, async (tx) => {
    await lockPerson(tx, tenantId, userId);
    const audit = auditor(tx, input, verificationId);
    const releasedNow = await tx.query<{ released: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM veteran_verifications
                       WHERE tenant_id = $1 AND user_id = $2 AND status = 'REVOKED')
           OR EXISTS (SELECT 1 FROM users
                       WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NOT NULL)
           AS released`,
      [tenantId, userId],
    );
    const released = releasedNow.rows[0]?.released === true;
    const settle = (
      status: VeteranConfirmationResult['status'],
      failureClass: string | null,
      reason: VaNotConfirmedReason | null,
      hash: typeof identity,
    ) =>
      tx.query<StandingRow>(
        `UPDATE veteran_verifications
            SET status = $2::suas_veteran_verification_status,
                verified_at = CASE WHEN $2 = 'VERIFIED' THEN clock_timestamp() END,
                not_confirmed_reason = $3::suas_va_not_confirmed_reason,
                failure_class = $4, identity_hash = $5, identity_key_id = $6,
                identity_released_at = CASE WHEN $7 THEN now() END,
                settled_at = clock_timestamp()
          WHERE verification_id = $1 AND status = 'PENDING'
          RETURNING ${STANDING_COLUMNS}`,
        [
          verificationId,
          status,
          reason,
          failureClass,
          released ? null : (hash?.hash ?? null),
          released ? null : (hash?.keyId ?? null),
          released,
        ],
      );
    const conflict = async () => {
      await settle('UNAVAILABLE', IDENTITY_CONFLICT_CLASS, null, undefined);
      await audit('VETERAN_VERIFICATION_SETTLED', 'SETTLE_VETERAN_VERIFICATION', {
        status: 'UNAVAILABLE',
        not_confirmed_reason: null,
        failure_class: IDENTITY_CONFLICT_CLASS,
      });
      return { kind: 'conflict' as const };
    };

    if (
      result.status === 'VERIFIED' &&
      !released &&
      (await identityHeldElsewhere(tx, keyring, tenantId, userId, input.projection))
    ) {
      return conflict();
    }
    await tx.query('SAVEPOINT va_settle');
    let rows: StandingRow[];
    try {
      rows = (
        await settle(
          result.status,
          result.failureClass ?? null,
          result.notConfirmedReason ?? null,
          identity,
        )
      ).rows;
    } catch (error: unknown) {
      const unique = (error as { code?: unknown; constraint?: unknown }) ?? {};
      if (
        unique.code !== '23505' ||
        unique.constraint !== 'veteran_verifications_verified_identity_key'
      ) {
        throw error;
      }
      await tx.query('ROLLBACK TO SAVEPOINT va_settle');
      return conflict();
    }
    const row = rows[0];
    if (row === undefined) {
      // A later request settled this attempt as a stale timeout; report that.
      const stale = await tx.query<StandingRow>(
        `SELECT ${STANDING_COLUMNS} FROM veteran_verifications WHERE verification_id = $1`,
        [verificationId],
      );
      const staleRow = stale.rows[0];
      if (staleRow === undefined) throw new Error('VA confirmation attempt was not recorded.');
      return { kind: 'settled' as const, standing: toStanding(staleRow) };
    }
    await audit('VETERAN_VERIFICATION_SETTLED', 'SETTLE_VETERAN_VERIFICATION', {
      status: result.status,
      not_confirmed_reason: result.notConfirmedReason ?? null,
      failure_class: result.failureClass ?? null,
    });
    return { kind: 'settled' as const, standing: toStanding(row) };
  });
  if (outcome.kind === 'conflict') throw new VaIdentityAlreadyVerifiedError();
  return outcome.standing;
}

/** Signature of the port call, so tests can hold it open between the two transactions. */
export type AskVa = (projection: VaConfirmationProjection) => Promise<VeteranConfirmationResult>;

/** What a request held back by the outage cooldown is told: the answer a VA 5xx gives. */
const VA_COOLING_DOWN: VeteranConfirmationStanding = {
  method: 'VA_VETERAN_STATUS',
  status: 'UNAVAILABLE',
  notConfirmedReason: undefined,
  verifiedAt: undefined,
  failureClass: 'PROVIDER_UNAVAILABLE',
};

/**
 * One VA attempt end to end: the outage cooldown admits it (while VA cools down: the outage
 * answer, no call and no attempt), then begin, ask VA with no transaction open, settle. A
 * port that throws (it should not) settles as UNAVAILABLE NETWORK_ERROR.
 */
export async function confirmVeteranStatus(
  pool: Pool,
  keyring: FingerprintKeyring,
  ask: AskVa,
  input: VaAttemptInput,
): Promise<VeteranConfirmationStanding> {
  const admission = await acquireVaCall(pool);
  if (admission.kind === 'open') return VA_COOLING_DOWN;
  let result: VeteranConfirmationResult | undefined;
  try {
    const start = await beginVaAttempt(pool, keyring, input);
    if (start.kind === 'answered') return start.result;
    try {
      result = await ask(input.projection);
    } catch {
      result = { status: 'UNAVAILABLE', failureClass: 'NETWORK_ERROR' };
    }
    return await settleVaAttempt(pool, keyring, input, start.verificationId, result);
  } finally {
    await recordVaCallOutcome(pool, result, admission);
  }
}

/** Contract version recorded on a self-attestation row (D-016 fallback). */
export const SELF_ATTESTATION_CONTRACT_VERSION = 'suas-self-attestation-v1';

/**
 * D-016 self-attestation (R9.1 D1): writes a SELF_ATTESTATION VERIFIED row with source
 * SUAS. No VA call and no attempt limit. A REVOKED standing is refused; any VERIFIED
 * standing is returned as is with no new row.
 */
export async function selfAttestVeteranStatus(
  tx: Queryable,
  input: { tenantId: string; userId: string; correlationId?: string },
): Promise<{ verificationId: string | undefined; standing: VeteranConfirmationStanding }> {
  const { tenantId, userId } = input;
  await lockPerson(tx, tenantId, userId);
  const current = await readVeteranConfirmation(tx, tenantId, userId);
  if (current?.status === 'REVOKED') throw new VeteranConfirmationRevokedError();
  if (current?.status === 'VERIFIED') return { verificationId: undefined, standing: current };

  const verificationId = randomUUID();
  const inserted = await tx.query<StandingRow>(
    `INSERT INTO veteran_verifications
       (verification_id, tenant_id, user_id, method, status, source, source_contract_version,
        verified_at, settled_at)
     VALUES ($1, $2, $3, 'SELF_ATTESTATION', 'VERIFIED', 'SUAS', $4, clock_timestamp(),
             clock_timestamp())
     RETURNING ${STANDING_COLUMNS}`,
    [verificationId, tenantId, userId, SELF_ATTESTATION_CONTRACT_VERSION],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('Self-attestation was not recorded.');
  await appendAuditEvent(tx, {
    eventType: 'VETERAN_SELF_ATTESTED',
    action: 'SELF_ATTEST_VETERAN_STATUS',
    targetType: 'VeteranVerification',
    targetId: verificationId,
    aggregateType: 'User',
    aggregateId: userId,
    tenantId,
    actorType: 'USER',
    actorId: userId,
    payload: { method: 'SELF_ATTESTATION', status: 'VERIFIED' },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
  return { verificationId, standing: toStanding(row) };
}
