/**
 * Helpers for reading AWS SDK errors inside adapters.
 *
 * AWS SDK v3 errors carry a stable `name` (for example `ThrottlingException`)
 * and `$metadata.httpStatusCode`. These helpers keep that vocabulary inside
 * adapters so ports expose only SUAS-owned failure kinds (AGENTS.md rule 6).
 */

/** Error class name, or undefined when the thrown value is not an object. */
export function awsErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const name = (error as { name?: unknown }).name;
  return typeof name === 'string' ? name : undefined;
}

const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
  'TimeoutError',
  'AbortError',
  'RequestTimeout',
  'RequestTimeoutException',
  'ModelTimeoutException',
]);

/** True for client-side aborts and service-reported timeouts. */
export function isAwsTimeout(error: unknown): boolean {
  const name = awsErrorName(error);
  return name !== undefined && TIMEOUT_ERROR_NAMES.has(name);
}

/** HTTP status the SDK recorded for a failed call, if any. */
export function awsHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
  return typeof metadata?.httpStatusCode === 'number' ? metadata.httpStatusCode : undefined;
}
