/**
 * Outbound fetch timeout (ARCHITECTURE.md §13).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { fetchWithTimeout, OUTBOUND_FETCH_TIMEOUT_MS } from '../../src/resilience/index.js';

describe('fetchWithTimeout', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('attaches a timeout AbortSignal to outbound fetch', async () => {
    let seen: RequestInit | undefined;
    const stub: typeof fetch = (_input, init) => {
      seen = init;
      return Promise.resolve(new Response('{}'));
    };
    globalThis.fetch = stub;

    await fetchWithTimeout('https://example.test/token', { method: 'GET' });
    expect(seen?.signal).toBeDefined();
    expect(seen?.signal?.aborted).toBe(false);
    expect(OUTBOUND_FETCH_TIMEOUT_MS).toBe(10_000);
  });
});
