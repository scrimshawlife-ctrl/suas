import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useSingleFlight } from './single-flight';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSingleFlight', () => {
  it('drops a second call made while the first is still running', () => {
    const { result } = renderHook(() => useSingleFlight());
    const action = vi.fn(() => new Promise<void>(() => undefined));
    result.current(action);
    result.current(action);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('runs again once the first call has settled, after success or failure', async () => {
    const { result } = renderHook(() => useSingleFlight());
    const first = deferred();
    result.current(() => first.promise);
    await act(async () => {
      first.resolve();
      await first.promise;
    });

    const second = deferred();
    const secondAction = vi.fn(() => second.promise);
    result.current(secondAction);
    expect(secondAction).toHaveBeenCalledTimes(1);
    await act(async () => {
      second.reject(new Error('offline'));
      await second.promise.catch(() => undefined);
    });

    const third = vi.fn(() => Promise.resolve());
    result.current(third);
    expect(third).toHaveBeenCalledTimes(1);
  });

  it('releases and rethrows when the action throws before returning a promise', () => {
    const { result } = renderHook(() => useSingleFlight());
    expect(() =>
      result.current(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    const next = vi.fn(() => Promise.resolve());
    result.current(next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
