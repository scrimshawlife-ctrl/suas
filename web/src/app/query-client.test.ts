import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/errors';
import { createQueryClient } from './query-client';

// G1: every query, not only the hooks that opted in, leaves a 4xx alone and retries the rest.
describe('createQueryClient default retry', () => {
  const retry = createQueryClient().getDefaultOptions().queries?.retry;
  const shouldRetry = (failureCount: number, error: unknown) =>
    typeof retry === 'function' && retry(failureCount, error as Error);

  it('does not retry a 4xx, which will not change on retry', () => {
    for (const status of [400, 403, 404, 408, 409, 422, 429]) {
      expect(shouldRetry(0, new ApiError(status, 'X', 'x'))).toBe(false);
    }
  });

  it('retries a 5xx or a dropped connection twice more, then stops', () => {
    const serverError = new ApiError(503, 'X', 'x');
    expect([0, 1, 2].map((n) => shouldRetry(n, serverError))).toEqual([true, true, false]);
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
  });
});
