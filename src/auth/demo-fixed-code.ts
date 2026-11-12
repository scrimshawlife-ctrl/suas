/**
 * Demo helpers for the email OTP sign-in flow. Sign-in normally issues a
 * random six digit code. One synthetic account, `demo@example.invalid`, can
 * receive a fixed code when every gate below passes.
 *
 * Only LOCAL, with the explicit opt-in and a loopback database URL, issues it.
 * TEST, STAGING and PRODUCTION never receive a fixed code.
 *
 * Callers must fall back to a random code whenever these helpers return
 * `undefined`.
 */

/** The fixed six digit code handed to the synthetic demo account. */
export const DEMO_FIXED_CODE = '123456';

/** The exact normalized destination that may receive the fixed code. */
export const DEMO_FIXED_CODE_DESTINATION = 'demo@example.invalid';

/**
 * Issue and verify budget for the one shared demo account, per 15 minute
 * window. The pilot limit of three issuances would lock a public sign-in
 * page. Sixty is enough for a demo and still stops a tight loop.
 */
export const DEMO_SHARED_ACCOUNT_LIMIT = 60;

/**
 * Resolves a normalized destination to a fixed OTP code, or `undefined` when the
 * caller must generate a random code instead.
 */
export type FixedOtpCodeFor = (normalizedDestination: string) => string | undefined;

/** Loopback hostnames, compared after brackets are stripped and case folded. */
const LOOPBACK_HOSTNAMES: readonly string[] = ['localhost', '127.0.0.1', '::1'];

/**
 * True only when the URL parses, is postgres or postgresql, and points at a
 * database running on this machine. Never throws: `undefined` or unparseable
 * input is false.
 */
export function isLocalDemoDatabaseUrl(databaseUrl: string | undefined): boolean {
  if (databaseUrl === undefined) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    return false;
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[/, '').replace(/]$/, '');
  return LOOPBACK_HOSTNAMES.includes(hostname);
}

/**
 * Builds a fixed code resolver, or `undefined` unless every gate passes:
 * LOCAL, the explicit opt-in, and a loopback database URL. Any other
 * environment class returns `undefined` even if the flag is set.
 */
export function demoFixedCodeFor(opts: {
  readonly environment: string;
  readonly demoFixedCode: boolean;
  readonly databaseUrl: string | undefined;
}): FixedOtpCodeFor | undefined {
  if (
    !opts.demoFixedCode ||
    opts.environment !== 'LOCAL' ||
    !isLocalDemoDatabaseUrl(opts.databaseUrl)
  ) {
    return undefined;
  }
  return (normalizedDestination) =>
    normalizedDestination === DEMO_FIXED_CODE_DESTINATION ? DEMO_FIXED_CODE : undefined;
}
