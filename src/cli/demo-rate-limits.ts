import type { Queryable } from '../db/transaction.js';

/**
 * Suffix shared by every synthetic demo account, for example
 * `demo@example.invalid`. Only the LOCAL demo seed targets this domain, and
 * `@` and `.` are not LIKE wildcards (`_` and `%` are, and the domain has
 * neither), so a suffix match cannot reach a real destination.
 */
export const DEMO_SUBJECT_DOMAIN = '@example.invalid';

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
 * issued. Targets only the demo domain, never a real destination. Returns the
 * number of rows deleted, or 0 when the driver reports no row count.
 */
export async function clearDemoSignInRateLimits(
  db: Queryable,
  opts: { environment: string; databaseUrl: string | undefined },
): Promise<number> {
  assertLocalDemoDatabase(opts.environment, opts.databaseUrl);

  const result = await db.query('DELETE FROM auth_rate_limits WHERE subject LIKE $1', [
    `%${DEMO_SUBJECT_DOMAIN}`,
  ]);

  return result.rowCount ?? 0;
}
