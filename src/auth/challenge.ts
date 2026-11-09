/**
 * Passwordless authentication challenges.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §2 (magic link, email OTP, phone OTP; no veteran password
 *   or social login)
 * - SUAS-specs AUTH.md §3 (challenge contract: single-use, time-bounded, stored
 *   hashed, rate-limited, consumed atomically; two simultaneous verifies produce
 *   at most one successful consumption)
 * - SUAS-specs AUTH.md §8 (audit challenge issuance and verification outcome)
 * - SUAS-specs AUTH.md §9 (an unavailable delivery provider means an unavailable
 *   channel; do not fake success)
 * - SUAS-specs DATA_MODEL.md §2 "auth_challenges", §14 rule 3 (one challenge
 *   consumed at most once)
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';
import type { Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';
import { createUser, findUserByDestination, type User } from '../identity/users.js';
import {
  CHALLENGE_ISSUE_LIMIT,
  CHALLENGE_ISSUE_WINDOW_SECONDS,
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_SECONDS,
  CHALLENGE_VERIFY_LIMIT,
  CHALLENGE_VERIFY_WINDOW_SECONDS,
} from './constants.js';
import { DEMO_SHARED_ACCOUNT_LIMIT } from './demo-fixed-code.js';
import {
  channelForMethod,
  ChannelUnavailableError,
  type ChallengeDeliveryPort,
  type ChallengeMethod,
} from './delivery.js';
import { enforceRateLimit } from './rate-limit.js';
import {
  credentialMatches,
  generateOpaqueToken,
  generateOtpCode,
  hashCredential,
  normalizeDestination,
} from './secrets.js';
import type { FixedOtpCodeFor } from './demo-fixed-code.js';
import {
  publicSignUpPermitted,
  stagingFixturePrincipalRefused,
  type StagingAccess,
} from './staging-access.js';

export type ChallengeStatus = 'ISSUED' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface IssueChallengeInput {
  readonly tenantId: string;
  readonly destination: string;
  readonly method: ChallengeMethod;
  /**
   * Self sign-up (v1 web): an unknown email address still gets an EMAIL_OTP code, and
   * verifying it creates the user. The caller answers the same 202 either way, so the
   * response reveals nothing about who is enrolled. Ignored for other methods.
   * Refused outside LOCAL and TEST, including when the caller sets it on STAGING (D-052).
   */
  readonly allowSignUp?: boolean;
  readonly correlationId?: string;
}

/** Deliberately loose: enough to keep junk out of `users.email`; the mail provider is the real check. */
const SIGN_UP_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface IssueChallengeResult {
  /**
   * Whether a challenge was actually created and delivered.
   *
   * False when the destination is not enrolled. The caller returns the same
   * response either way so the endpoint cannot be used to enumerate which
   * addresses belong to veterans; the distinction is recorded in the Audit Event
   * rather than in the response.
   */
  readonly issued: boolean;
  readonly challengeId: string | undefined;
  readonly expiresAt: Date | undefined;
}

export class ChallengeVerificationFailedError extends Error {
  readonly code = 'CHALLENGE_INVALID';
  readonly httpStatus = 401;

  constructor() {
    // Deliberately uniform: a caller cannot tell "wrong code" from "expired",
    // "already used", or "no such challenge".
    super('The sign-in code is invalid or has expired.');
    this.name = 'ChallengeVerificationFailedError';
  }
}

export interface ChallengeServiceDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly delivery: ChallengeDeliveryPort;
  /**
   * LOCAL demo only (src/auth/demo-fixed-code.ts): returns a fixed one-time code for
   * the synthetic demo destination. Absent in every other environment class.
   */
  readonly fixedOtpCodeFor?: FixedOtpCodeFor | undefined;
  /** Present on the server. STAGING uses it to refuse a non-fixture account. */
  readonly stagingAccess?: StagingAccess | undefined;
}

/**
 * Issue and deliver a challenge.
 *
 * Order matters: channel availability and rate limits are checked before any
 * record is written, so an unavailable channel produces no challenge at all
 * rather than an undeliverable one.
 */
export async function issueChallenge(
  deps: ChallengeServiceDeps,
  input: IssueChallengeInput,
): Promise<IssueChallengeResult> {
  const destination = normalizeDestination(input.destination);
  const channel = channelForMethod(input.method);
  const fixedCode = input.method === 'EMAIL_OTP' ? deps.fixedOtpCodeFor?.(destination) : undefined;

  // AUTH.md §9: an unavailable channel is reported, never faked.
  if (!deps.delivery.availableChannels().includes(channel)) {
    throw new ChannelUnavailableError(channel);
  }

  // AUTH.md §3: rate limited by destination, in shared persistent state.
  // The shared synthetic demo account uses a higher budget so the public
  // sign-in page is not locked after three visitors.
  await enforceRateLimit(
    deps.pool,
    {
      bucket: 'auth.challenge.issue',
      limit: fixedCode === undefined ? CHALLENGE_ISSUE_LIMIT.value : DEMO_SHARED_ACCOUNT_LIMIT,
      windowSeconds: CHALLENGE_ISSUE_WINDOW_SECONDS.value,
    },
    destination,
  );

  const user = await findUserByDestination(deps.pool, input.tenantId, destination);
  const signUp =
    user === undefined &&
    input.allowSignUp === true &&
    publicSignUpPermitted(deps.stagingAccess) &&
    input.method === 'EMAIL_OTP' &&
    SIGN_UP_EMAIL_PATTERN.test(destination);
  const fixtureRefused =
    deps.stagingAccess !== undefined &&
    stagingFixturePrincipalRefused(
      deps.stagingAccess,
      user === undefined ? undefined : { tenantId: user.tenantId, userId: user.userId },
    );
  if (fixtureRefused) {
    await recordChallengeAudit(deps.pool, {
      tenantId: input.tenantId,
      action: 'AUTH_CHALLENGE_ISSUE_SKIPPED',
      outcome: 'NOT_STAGING_FIXTURE',
      method: input.method,
      actorId: user?.userId ?? 'anonymous',
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return { issued: false, challengeId: undefined, expiresAt: undefined };
  }

  // Every branch does the same database work: one challenge row and one audit event in a
  // transaction, and the same hashing. They differ only in whether a code is delivered, so
  // neither the answer nor the database time says whether an address is enrolled. A person who
  // may not receive a code gets a row that is already REVOKED, which verify never selects.
  // A STAGING account that is not an admitted fixture pair is not deliverable.
  const deliverable =
    !fixtureRefused &&
    (signUp || (user !== undefined && user.status !== 'REVOKED' && user.status !== 'SUSPENDED'));
  const secret =
    input.method === 'MAGIC_LINK' ? generateOpaqueToken() : (fixedCode ?? generateOtpCode());
  const challengeId = randomUUID();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS.value * 1000);

  await withTransaction(deps.pool, async (tx) => {
    await tx.query(
      `INSERT INTO auth_challenges
         (auth_challenge_id, tenant_id, user_id, method, destination, secret_hash,
          max_attempts, expires_at, correlation_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        challengeId,
        input.tenantId,
        user?.userId ?? null,
        input.method,
        destination,
        hashCredential(deps.sessionSecret, secret),
        CHALLENGE_MAX_ATTEMPTS.value,
        expiresAt,
        input.correlationId ?? null,
        deliverable ? 'ISSUED' : 'REVOKED',
      ],
    );

    await appendAuditEvent(tx, {
      eventType: deliverable ? 'AUTH_CHALLENGE_ISSUED' : 'AUTH_CHALLENGE_ISSUE_SKIPPED',
      action: deliverable ? 'ISSUE_AUTH_CHALLENGE' : 'AUTH_CHALLENGE_ISSUE_SKIPPED',
      targetType: 'AuthChallenge',
      targetId: challengeId,
      aggregateType: 'User',
      // A sign-up has no user yet; the challenge id stands in as the aggregate.
      aggregateId: user?.userId ?? challengeId,
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: deliverable ? 'auth' : (user?.userId ?? 'anonymous'),
      // The destination is a contact identifier; only the method is recorded.
      payload: deliverable
        ? { method: input.method, channel, ...(signUp ? { sign_up: true } : {}) }
        : {
            method: input.method,
            outcome: fixtureRefused
              ? 'NOT_STAGING_FIXTURE'
              : user === undefined
                ? 'NO_ENROLLED_USER'
                : `USER_${user.status}`,
          },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  });

  if (!deliverable) return { issued: false, challengeId: undefined, expiresAt: undefined };

  // Delivery happens after commit: a delivery failure must not leave a phantom
  // challenge, and the challenge must exist before a code can arrive.
  // A failed send (provider outage, or example.invalid is not a mailbox) must not change the
  // answer either: unknown and suspended addresses send nothing and cannot fail, so a failure
  // that surfaced would reveal an enrolled address. It is audited and the answer is unchanged.
  try {
    await deps.delivery.deliver({
      channel,
      destination,
      method: input.method,
      secret,
      expiresAt,
    });
  } catch (error: unknown) {
    const errorName = error instanceof Error ? error.name : 'unknown';
    console.error(
      JSON.stringify({
        level: 'warn',
        msg: 'challenge_delivery_not_accepted',
        error_name: errorName,
      }),
    );
    await withTransaction(deps.pool, (tx) =>
      appendAuditEvent(tx, {
        eventType: 'AUTH_CHALLENGE_DELIVERY_FAILED',
        action: 'DELIVER_AUTH_CHALLENGE',
        targetType: 'AuthChallenge',
        targetId: challengeId,
        aggregateType: 'User',
        aggregateId: user?.userId ?? challengeId,
        tenantId: input.tenantId,
        actorType: 'SYSTEM',
        actorId: 'auth',
        payload: { method: input.method, channel, error_name: errorName },
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
      }),
    );
  }

  return { issued: true, challengeId, expiresAt };
}

export interface VerifyChallengeInput {
  readonly tenantId: string;
  readonly destination: string;
  readonly secret: string;
  readonly correlationId?: string;
}

interface ChallengeRow {
  auth_challenge_id: string;
  user_id: string | null;
  secret_hash: string;
  status: ChallengeStatus;
  attempts: number;
  max_attempts: number;
  expires_at: Date;
}

/**
 * Verify a challenge and return the authenticated user.
 *
 * The whole check runs inside one transaction with the challenge row locked
 * `FOR UPDATE`, which is what makes AUTH.md §3's concurrency rule hold: two
 * simultaneous verifies of one challenge produce at most one consumption.
 */
export async function verifyChallenge(
  deps: ChallengeServiceDeps,
  input: VerifyChallengeInput,
): Promise<User> {
  const destination = normalizeDestination(input.destination);
  const fixedCode = deps.fixedOtpCodeFor?.(destination);

  // A shared verify budget per destination, so rotating challenges or app
  // instances does not reset an attacker's attempts (AUTH.md §11).
  await enforceRateLimit(
    deps.pool,
    {
      bucket: 'auth.challenge.verify',
      limit: fixedCode === undefined ? CHALLENGE_VERIFY_LIMIT.value : DEMO_SHARED_ACCOUNT_LIMIT,
      windowSeconds: CHALLENGE_VERIFY_WINDOW_SECONDS.value,
    },
    destination,
  );

  const userId = await withTransaction(deps.pool, async (tx) => {
    const result = await tx.query<ChallengeRow>(
      `SELECT auth_challenge_id, user_id, secret_hash, status, attempts, max_attempts, expires_at
       FROM auth_challenges
       WHERE tenant_id = $1 AND destination = $2 AND status = 'ISSUED'
       ORDER BY issued_at DESC
       LIMIT 1
       FOR UPDATE`,
      [input.tenantId, destination],
    );

    const challenge = result.rows[0];
    if (challenge === undefined) return undefined;

    if (challenge.expires_at.getTime() <= Date.now()) {
      await tx.query(`UPDATE auth_challenges SET status = 'EXPIRED' WHERE auth_challenge_id = $1`, [
        challenge.auth_challenge_id,
      ]);
      return undefined;
    }

    if (challenge.attempts >= challenge.max_attempts) {
      await tx.query(`UPDATE auth_challenges SET status = 'REVOKED' WHERE auth_challenge_id = $1`, [
        challenge.auth_challenge_id,
      ]);
      return undefined;
    }

    if (!credentialMatches(deps.sessionSecret, input.secret, challenge.secret_hash)) {
      const attempts = challenge.attempts + 1;
      await tx.query(
        `UPDATE auth_challenges
           SET attempts = $2, status = CASE WHEN $2 >= max_attempts THEN 'REVOKED' ELSE status END
         WHERE auth_challenge_id = $1`,
        [challenge.auth_challenge_id, attempts],
      );
      return undefined;
    }

    // Single-use consumption. The row lock above already serialized concurrent
    // verifies; the status predicate makes the write itself unambiguous.
    const consumed = await tx.query(
      `UPDATE auth_challenges
         SET status = 'CONSUMED', consumed_at = now(), attempts = attempts + 1
       WHERE auth_challenge_id = $1 AND status = 'ISSUED'`,
      [challenge.auth_challenge_id],
    );
    if ((consumed.rowCount ?? 0) === 0) return undefined;

    await appendAuditEvent(tx, {
      eventType: 'AUTH_CHALLENGE_VERIFIED',
      action: 'VERIFY_AUTH_CHALLENGE',
      targetType: 'AuthChallenge',
      targetId: challenge.auth_challenge_id,
      aggregateType: 'User',
      aggregateId: challenge.user_id ?? randomUUID(),
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: 'auth',
      payload: { outcome: 'SUCCESS' },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    if (challenge.user_id !== null) return challenge.user_id;

    // A sign-up challenge has no user yet. Proving control of the address creates one,
    // unless the address was enrolled in the meantime, in which case that person signs in.
    const existing = await findUserByDestination(tx, input.tenantId, destination);
    if (existing !== undefined) return existing.userId;
    // A concurrent sign-up of the same address loses on the unique index. A savepoint keeps
    // the transaction usable so the winner can be re-read; the pg error is dropped here
    // because its detail quotes the email address.
    await tx.query('SAVEPOINT self_sign_up');
    let created: User;
    try {
      created = await createUser(tx, {
        tenantId: input.tenantId,
        email: destination,
        status: 'ACTIVE',
      });
      await tx.query('RELEASE SAVEPOINT self_sign_up');
    } catch (error: unknown) {
      if ((error as { code?: unknown } | null)?.code !== '23505') throw error;
      await tx.query('ROLLBACK TO SAVEPOINT self_sign_up');
      const winner = await findUserByDestination(tx, input.tenantId, destination);
      if (winner === undefined) throw new ChallengeVerificationFailedError();
      return winner.userId;
    }
    await appendAuditEvent(tx, {
      eventType: 'USER_SELF_SIGNED_UP',
      action: 'CREATE_USER',
      targetType: 'User',
      targetId: created.userId,
      aggregateType: 'User',
      aggregateId: created.userId,
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: 'auth',
      payload: { method: 'EMAIL_OTP' },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return created.userId;
  });

  if (userId === undefined) {
    await recordChallengeAudit(deps.pool, {
      tenantId: input.tenantId,
      action: 'AUTH_CHALLENGE_VERIFY_FAILED',
      outcome: 'FAILURE',
      actorId: 'anonymous',
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    throw new ChallengeVerificationFailedError();
  }

  const user = await findUserByDestination(deps.pool, input.tenantId, destination);
  // AUTH.md §6: User.status = ACTIVE is required to act. A challenge verified by
  // a user who is no longer active does not produce a session.
  if (
    user === undefined ||
    user.userId !== userId ||
    user.status === 'SUSPENDED' ||
    user.status === 'REVOKED'
  ) {
    throw new ChallengeVerificationFailedError();
  }
  return user;
}

/** Revoke every live challenge for a destination, e.g. after a successful sign-in. */
export async function revokeLiveChallenges(
  db: Queryable,
  tenantId: string,
  destination: string,
): Promise<number> {
  const result = await db.query(
    `UPDATE auth_challenges SET status = 'REVOKED'
     WHERE tenant_id = $1 AND destination = $2 AND status = 'ISSUED'`,
    [tenantId, normalizeDestination(destination)],
  );
  return result.rowCount ?? 0;
}

async function recordChallengeAudit(
  db: Pool,
  input: {
    tenantId: string;
    action: string;
    outcome: string;
    actorId: string;
    method?: ChallengeMethod;
    correlationId?: string;
  },
): Promise<void> {
  await withTransaction(db, (tx) =>
    appendAuditEvent(tx, {
      eventType: input.action,
      action: input.action,
      targetType: 'AuthChallenge',
      targetId: 'none',
      aggregateType: 'User',
      aggregateId: randomUUID(),
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: input.actorId,
      payload: {
        outcome: input.outcome,
        ...(input.method !== undefined ? { method: input.method } : {}),
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    }),
  );
}
