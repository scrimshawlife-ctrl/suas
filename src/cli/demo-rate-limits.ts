import { rateLimitSubject } from '../auth/rate-limit.js';
import { normalizeDestination } from '../auth/secrets.js';
import type { Queryable } from '../db/transaction.js';
import { syntheticEmail } from '../testing/fixture-boundary.js';
import { SEED_ACCOUNT_LOCAL_PARTS } from './seed-local.js';

/** demo@example.invalid: the primary demo Veteran (open case, four requests, fixed code). */
export const DEMO_VETERAN_LOCAL_PART = 'demo';
/** newvet@example.invalid: enrolled, no case yet. */
export const FRESH_VETERAN_LOCAL_PART = 'newvet';

/**
 * Every address the LOCAL demo seed signs in with. Listed, not looked up in `users`, so an
 * account not yet enrolled is cleared too (review of #374, 2026-11-25).
 */
export const DEMO_SIGN_IN_ADDRESSES: readonly string[] = [
  DEMO_VETERAN_LOCAL_PART,
  FRESH_VETERAN_LOCAL_PART,
  SEED_ACCOUNT_LOCAL_PARTS.admin,
  SEED_ACCOUNT_LOCAL_PARTS.accepter,
  SEED_ACCOUNT_LOCAL_PARTS.veteranTwo,
].map(syntheticEmail);

const SIGN_IN_BUCKETS: readonly string[] = ['auth.challenge.issue', 'auth.challenge.verify'];

const LOCAL_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '::1', '[::1]'];

/**
 * LOCAL-only guard for the demo rate-limit helpers. Throws unless the
 * environment is exactly `LOCAL` and the database URL is a postgres URL whose
 * hostname is a loopback address. STAGING, TEST, PRODUCTION, remote hosts, and
 * non-postgres URLs are refused here, so no statement is ever prepared against
 * them. The password in the URL is never included in the message; only the
 * hostname is reported.
 */
export function assertLocalDemoDatabase(
  environment: string,
  databaseUrl: string | undefined,
): void {
  if (environment !== 'LOCAL') {
    throw new Error(`Refusing demo rate-limit change outside LOCAL: environment "${environment}"`);
  }

  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('Refusing demo rate-limit change: databaseUrl is not set');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('Refusing demo rate-limit change: databaseUrl is not a valid URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `Refusing demo rate-limit change: protocol "${parsed.protocol}" is not postgres`,
    );
  }

  if (!LOCAL_HOSTNAMES.includes(parsed.hostname)) {
    throw new Error(`Refusing demo rate-limit change: host "${parsed.hostname}" is not loopback`);
  }
}

/**
 * Clears the sign-in rate-limit windows for the synthetic demo accounts, LOCAL
 * only. `assertLocalDemoDatabase` runs first, so anything other than a LOCAL
 * environment on a loopback postgres database is rejected before a query is
 * issued. Targets only the listed demo addresses, never a real destination. Returns
 * the number of rows deleted, or 0 when the driver reports no row count.
 */
export async function clearDemoSignInRateLimits(
  db: Queryable,
  opts: { environment: string; databaseUrl: string | undefined; sessionSecret: string | undefined },
): Promise<number> {
  assertLocalDemoDatabase(opts.environment, opts.databaseUrl);

  // Keyed subjects for both sign-in buckets, plus the legacy plaintext form a counter written
  // before keying still carries (review of #374, 2026-11-25).
  const subjects = SIGN_IN_BUCKETS.flatMap((bucket) =>
    DEMO_SIGN_IN_ADDRESSES.flatMap((address) => {
      const subject = rateLimitSubject(opts.sessionSecret, bucket, normalizeDestination(address));
      return [subject.key, subject.legacy];
    }),
  );
  const result = await db.query(
    'DELETE FROM auth_rate_limits WHERE bucket = ANY($1::text[]) AND subject = ANY($2::text[])',
    [SIGN_IN_BUCKETS, subjects],
  );

  return result.rowCount ?? 0;
}
