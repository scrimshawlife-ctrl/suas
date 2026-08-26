/**
 * Bounded outbound HTTP for adapter transports.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §13 (finite timeouts; no production SLO implied)
 *
 * Idempotency and retry classification stay in the fulfillment and
 * idempotency kernels. This helper only prevents an outbound call from
 * waiting without a deadline.
 */

/** Implementation-owned bound. Not a released SLO (D-021 is open). */
export const OUTBOUND_FETCH_TIMEOUT_MS = 10_000;

/**
 * `fetch` with a finite timeout. Combines a caller-supplied AbortSignal
 * with the timeout when both are present.
 */
export function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const timeout = AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS);
  const signal =
    init.signal === undefined || init.signal === null
      ? timeout
      : AbortSignal.any([init.signal, timeout]);
  return fetch(url, { ...init, signal });
}
