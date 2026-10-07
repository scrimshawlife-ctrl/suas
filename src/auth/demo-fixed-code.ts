/**
 * Local demo only helpers for the email OTP sign-in flow. Sign-in normally
 * issues a random six digit code; for the local demo a presenter can pin the
 * code for the single synthetic account `demo@example.invalid`.
 *
 * Three independent gates must all pass before a fixed code is offered, and
 * callers must fall back to a random code whenever these helpers return
 * `undefined`.
 */

/** The fixed six digit code handed to the synthetic demo account. */
export const DEMO_FIXED_CODE = '123456';

/** The exact normalized destination that may receive the fixed code. */
export const DEMO_FIXED_CODE_DESTINATION = 'demo@example.invalid';

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
 *
 * Under `wrangler dev` the Worker cannot see the real upstream host. It only
 * sees Cloudflare's local Hyperdrive proxy hostname, `<uuid>.hyperdrive.local`,
 * so that suffix is accepted here. The `npm run dev:demo` launcher has already
 * refused to start with any non-loopback upstream database, which is what keeps
 * this suffix safe.
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
  return LOOPBACK_HOSTNAMES.includes(hostname) || hostname.endsWith('.hyperdrive.local');
}

/**
 * Builds a fixed code resolver, or `undefined` unless every gate passes: the
 * environment class is exactly `LOCAL`, the explicit `enabled` opt in was parsed
 * to `true` by config (which already rejects it outside LOCAL), and the database
 * URL is local.
 */
export function demoFixedCodeFor(opts: {
  readonly environment: string;
  readonly demoFixedCode: boolean;
  readonly databaseUrl: string | undefined;
}): FixedOtpCodeFor | undefined {
  if (opts.environment !== 'LOCAL') {
    return undefined;
  }
  if (!opts.demoFixedCode) {
    return undefined;
  }
  if (!isLocalDemoDatabaseUrl(opts.databaseUrl)) {
    return undefined;
  }
  return (normalizedDestination) =>
    normalizedDestination === DEMO_FIXED_CODE_DESTINATION ? DEMO_FIXED_CODE : undefined;
}
