import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cursorPages, useSignedInInfiniteQuery, useSignedInQuery } from './queries';
import { tokenStore } from './token-store';

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

beforeEach(() => tokenStore.clear());

describe('useSignedInQuery', () => {
  it('sends nothing without a session token, nor while `enabled` is false', () => {
    const queryFn = vi.fn().mockResolvedValue(1);
    renderHook(() => useSignedInQuery({ queryKey: ['a'], queryFn }), { wrapper }).unmount();
    tokenStore.setToken('tok');
    renderHook(() => useSignedInQuery({ queryKey: ['b'], queryFn, enabled: false }), { wrapper });
    expect(queryFn).not.toHaveBeenCalled();
  });

  it('runs once signed in', async () => {
    tokenStore.setToken('tok');
    const { result } = renderHook(
      () => useSignedInQuery({ queryKey: ['c'], queryFn: () => Promise.resolve(1) }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data).toBe(1));
  });

  it('lets a fetch in flight settle when the session ends, then sends nothing more', async () => {
    tokenStore.setToken('tok');
    let answer: (value: number) => void = () => undefined;
    const queryFn = vi.fn(() => new Promise<number>((resolve) => (answer = resolve)));
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useSignedInQuery({ queryKey: ['d'], queryFn }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      ),
    });
    await waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1));
    act(() => tokenStore.clear());
    act(() => answer(1));
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    await act(() => queryClient.invalidateQueries({ queryKey: ['d'] }));
    expect(queryFn).toHaveBeenCalledTimes(1);
  });
});

describe('cursorPages', () => {
  it('sends no cursor first, then each next_cursor, and stops at a null one', async () => {
    tokenStore.setToken('tok');
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [1], next_cursor: 'c1' })
      .mockResolvedValueOnce({ items: [2], next_cursor: null });
    const { result } = renderHook(
      () => useSignedInInfiniteQuery(cursorPages({ queryKey: ['pages'], fetchPage })),
      { wrapper },
    );
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.hasNextPage).toBe(false));
    expect(fetchPage.mock.calls).toEqual([[{}], [{ cursor: 'c1' }]]);
  });

  it('treats an empty next_cursor as the last page and never sends an empty cursor', async () => {
    tokenStore.setToken('tok');
    const fetchPage = vi.fn().mockResolvedValue({ items: [1], next_cursor: '' });
    const { result } = renderHook(
      () => useSignedInInfiniteQuery(cursorPages({ queryKey: ['empty'], fetchPage })),
      { wrapper },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.hasNextPage).toBe(false);
    expect(fetchPage.mock.calls).toEqual([[{}]]);
  });
});
