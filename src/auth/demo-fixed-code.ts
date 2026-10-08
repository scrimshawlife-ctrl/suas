/**
 * Demo helpers for the email OTP sign-in flow. Sign-in normally issues a
 * random six digit code. One synthetic account, `demo@example.invalid`, can
 * receive a fixed code when every gate below passes.
 *
 * LOCAL still requires the explicit opt-in and a local database URL.
 * Synthetic STAGING can use the same account only inside the Worker runtime,
 * which has no path to a database except the Hyperdrive binding.
 * TEST and PRODUCTION never receive a fixed code.
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
 * Builds a fixed code resolver, or `undefined` unless every gate passes.
 *
 * LOCAL: explicit opt-in plus a local database URL (loopback, or the
 * `*.hyperdrive.local` proxy `wrangler dev` exposes).
 * STAGING: explicit opt-in plus `workerRuntime`, so a Node process that was
 * handed the remote staging URL cannot mint the known code.
 * Any other environment class returns `undefined` even if the flag is set.
 */
export function demoFixedCodeFor(opts: {
  readonly environment: string;
  readonly demoFixedCode: boolean;
  readonly databaseUrl: string | undefined;
  readonly workerRuntime?: boolean;
}): FixedOtpCodeFor | undefined {
  if (!opts.demoFixedCode) {
    return undefined;
  }
  const localDemo = opts.environment === 'LOCAL' && isLocalDemoDatabaseUrl(opts.databaseUrl);
  const stagingWorker = opts.environment === 'STAGING' && opts.workerRuntime === true;
  if (!localDemo && !stagingWorker) {
    return undefined;
  }
  return (normalizedDestination) =>
    normalizedDestination === DEMO_FIXED_CODE_DESTINATION ? DEMO_FIXED_CODE : undefined;
}
