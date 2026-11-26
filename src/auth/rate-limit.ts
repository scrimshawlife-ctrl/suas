/**
 * Shared, persistent rate limiting.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §3 — "Challenge issuance/verification state and
 *   rate-limit counters that protect correctness/abuse controls must be shared
 *   across horizontally scaled app instances... Process-local counters are not
 *   authoritative production controls."
 * - SUAS-specs AUTH.md §11 — a distributed/shared rate limit rejects abuse
 *   across instance rotation.
 * - SUAS-specs SECURITY.md §2 "Rate limits".
 * - SUAS-specs API.md §6 — 429 for rate/backpressure limits.
 *
 * The counter lives in PostgreSQL precisely so rotating app instances cannot
 * reset an attacker's budget.
 */

import { createHmac } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { SessionSecretMissingError } from './secrets.js';

const RATE_LIMIT_KEY_LABEL = 'suas.rate-limit.v1';
declare const rateLimitSubjectBrand: unique symbol;

/**
 * A subject ready for the counter: `key` is what is stored, `legacy` the pre-hash plaintext form
 * read once to fold an old counter in. Branded, so a plain string cannot reach the table.
 */
export interface RateLimitSubject {
  readonly key: string;
  readonly legacy: string;
  readonly [rateLimitSubjectBrand]: true;
}

/**
 * `hmac1:` + HMAC-SHA256(HMAC-SHA256(secret, label), bucket NUL raw). Keyed and bucket-scoped, so
 * a stored row cannot be matched to a low-entropy address without the secret (review of #374,
 * 2026-11-25); the labelled two-step key follows src/identity/fingerprint-keys.ts.
 */
export function rateLimitSubject(
  secret: string | undefined,
  bucket: string,
  raw: string,
): RateLimitSubject {
  if (secret === undefined || secret === '') {
    throw new SessionSecretMissingError();
  }
  const purposeKey = createHmac('sha256', secret).update(RATE_LIMIT_KEY_LABEL, 'utf8').digest();
  const digest = createHmac('sha256', purposeKey).update(`${bucket}\0${raw}`, 'utf8').digest('hex');
  return { key: `hmac1:${digest}`, legacy: raw } as RateLimitSubject;
}

export class RateLimitExceededError extends Error {
  readonly code = 'RATE_LIMITED';
  readonly httpStatus = 429;
  readonly retryAfterSeconds: number;

  constructor(bucket: string, retryAfterSeconds: number) {
    // The message names the bucket, never the subject, so a rate-limit response
    // cannot echo a veteran's address back to a caller.
    super(`Too many ${bucket} attempts. Retry in ${retryAfterSeconds}s.`);
    this.name = 'RateLimitExceededError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface RateLimitPolicy {
  readonly bucket: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitOutcome {
  readonly allowed: boolean;
  readonly count: number;
  readonly limit: number;
  readonly retryAfterSeconds: number;
}

/**
 * Count one attempt against a fixed window and report whether it is allowed.
 *
 * The window start is computed in the database from `now()`, so instances with
 * skewed clocks share one window boundary. A plaintext counter for the same window, written
 * before subjects were keyed, is deleted and added in by the same statement, so cutover never
 * restarts a live budget (review of #374, 2026-11-25).
 */
export async function consumeRateLimit(
  db: Queryable,
  policy: RateLimitPolicy,
  subject: RateLimitSubject,
): Promise<RateLimitOutcome> {
  const result = await db.query<{ count: number; retry_after: number }>(
    `WITH window_bounds AS (
       SELECT to_timestamp(floor(extract(epoch FROM now()) / $3) * $3) AS window_start
     ),
     legacy AS (
       DELETE FROM auth_rate_limits
       WHERE bucket = $1 AND subject = $4
         AND window_start = (SELECT window_start FROM window_bounds)
       RETURNING count
     ),
     bumped AS (
       INSERT INTO auth_rate_limits (bucket, subject, window_start, count)
       SELECT $1, $2, window_start, 1 + (SELECT COALESCE(sum(count), 0) FROM legacy)::int
       FROM window_bounds
       ON CONFLICT (bucket, subject, window_start)
         DO UPDATE SET count = auth_rate_limits.count + EXCLUDED.count, updated_at = now()
       RETURNING count, window_start
     )
     SELECT count,
            ceil(extract(epoch FROM (window_start + make_interval(secs => $3)) - now()))::int
              AS retry_after
     FROM bumped`,
    [policy.bucket, subject.key, policy.windowSeconds, subject.legacy],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('Rate limit counter did not return a row.');
  }

  return {
    allowed: row.count <= policy.limit,
    count: row.count,
    limit: policy.limit,
    retryAfterSeconds: Math.max(row.retry_after, 1),
  };
}

/** Consume one attempt and throw when the policy is exceeded. */
export async function enforceRateLimit(
  db: Queryable,
  policy: RateLimitPolicy,
  subject: RateLimitSubject,
): Promise<void> {
  const outcome = await consumeRateLimit(db, policy, subject);
  if (!outcome.allowed) {
    throw new RateLimitExceededError(policy.bucket, outcome.retryAfterSeconds);
  }
}

/**
 * Remove counters for windows that have fully elapsed.
 *
 * Rate-limit counters are abuse-control state, not business facts, so pruning
 * them is not the event/record retention that D-007 governs.
 */
export async function pruneRateLimits(
  db: Queryable,
  olderThanSeconds: number,
  buckets: readonly string[],
): Promise<number> {
  const result = await db.query(
    `DELETE FROM auth_rate_limits WHERE bucket = ANY($2::text[])
       AND window_start < now() - make_interval(secs => $1)`,
    [olderThanSeconds, buckets],
  );
  return result.rowCount ?? 0;
}
