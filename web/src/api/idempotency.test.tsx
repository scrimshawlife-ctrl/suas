import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useIdempotencyKey } from './idempotency';

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
