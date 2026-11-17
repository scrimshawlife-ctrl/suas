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
});
