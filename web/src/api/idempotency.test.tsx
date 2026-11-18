import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import {
  useBodyIdempotencyKey,
  useCommandKey,
  useIdempotencyKey,
  useKeyedIdempotency,
} from './idempotency';

const keyOf = (headers: Record<string, string>) => headers['Idempotency-Key'];

describe('useIdempotencyKey', () => {
  it('keeps one key across retries and changes it after renew()', () => {
    const { result, rerender } = renderHook(() => useIdempotencyKey());
    const first = result.current.current();
    rerender();
    expect(result.current.current()).toBe(first);
    expect(result.current.headers()).toEqual({ 'Idempotency-Key': first });
    result.current.renew();
    expect(result.current.current()).not.toBe(first);
  });
});

describe('useCommandKey', () => {
  it('keeps the key after a 5xx and renews it after a success or a 4xx', () => {
    const { result } = renderHook(() => useCommandKey());
    const first = keyOf(result.current.headers());
    result.current.settle(new ApiError(503, 'UNAVAILABLE', 'down'));
    expect(keyOf(result.current.headers())).toBe(first);
    result.current.settle(new ApiError(409, 'CONFLICT', 'moved'));
    const second = keyOf(result.current.headers());
    expect(second).not.toBe(first);
    result.current.settle();
    expect(keyOf(result.current.headers())).not.toBe(second);
  });

  it('keeps the key after a failure that is not an API answer (network error, abort)', () => {
    const { result } = renderHook(() => useCommandKey());
    const first = keyOf(result.current.headers());
    result.current.settle(new TypeError('Failed to fetch'));
    result.current.settle(new DOMException('The operation was aborted.', 'AbortError'));
    expect(keyOf(result.current.headers())).toBe(first);
  });
});

describe('useKeyedIdempotency', () => {
  it('keeps one key per target and renews only that target', () => {
    const { result } = renderHook(() => useKeyedIdempotency());
    const a = keyOf(result.current.headers('a'));
    const b = keyOf(result.current.headers('b'));
    expect(a).not.toBe(b);
    result.current.renew('a');
    expect(keyOf(result.current.headers('a'))).not.toBe(a);
    expect(keyOf(result.current.headers('b'))).toBe(b);
  });
});

describe('useBodyIdempotencyKey', () => {
  it('reuses the key for the same body and starts a new one for a changed or earlier body', () => {
    const { result } = renderHook(() => useBodyIdempotencyKey());
    const first = keyOf(result.current.headers({ n: 1 }));
    expect(keyOf(result.current.headers({ n: 1 }))).toBe(first);
    const second = keyOf(result.current.headers({ n: 2 }));
    expect(second).not.toBe(first);
    expect(keyOf(result.current.headers({ n: 1 }))).not.toBe(first);
    result.current.renew();
    expect(keyOf(result.current.headers({ n: 1 }))).not.toBe(
      keyOf(result.current.headers({ n: 2 })),
    );
  });

  it('treats bodies that differ only in key order, at any depth, as the same body', () => {
    const { result } = renderHook(() => useBodyIdempotencyKey());
    const first = keyOf(result.current.headers({ a: 1, b: { c: [1, { x: 1, y: 2 }], d: 2 } }));
    const reordered = keyOf(result.current.headers({ b: { d: 2, c: [1, { y: 2, x: 1 }] }, a: 1 }));
    expect(reordered).toBe(first);
    expect(keyOf(result.current.headers({ a: 1, b: { c: [{ x: 1, y: 2 }, 1], d: 2 } }))).not.toBe(
      first,
    );
  });
});
