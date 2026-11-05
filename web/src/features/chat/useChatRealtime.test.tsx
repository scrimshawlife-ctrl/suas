import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import { POLL_INTERVAL_MS, useChatRealtime } from './useChatRealtime';

const ticket = vi.hoisted(() => vi.fn());
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issueConnectTicket: ticket,
}));

function setup() {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { invalidate, wrapper };
}

beforeEach(() => {
  vi.useFakeTimers();
  tokenStore.setToken('tok');
  ticket.mockReset();
});
afterEach(() => {
  tokenStore.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useChatRealtime polling fallback', () => {
  it('refetches chat every 10 s when push is unavailable', async () => {
    ticket.mockRejectedValue(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'));
    const { invalidate, wrapper } = setup();
    const { result } = renderHook(() => useChatRealtime(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(result.current).toBe('polling');
    expect(invalidate).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));
    expect(invalidate).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['chat'] });
  });

  it('stops polling and opens no socket after sign-out', async () => {
    ticket.mockRejectedValue(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'));
    const { invalidate, wrapper } = setup();
    renderHook(() => useChatRealtime(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => {
      tokenStore.signOut();
    });
    await act(() => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('closes its socket on unmount', async () => {
    const sockets: { close: ReturnType<typeof vi.fn> }[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        close = vi.fn();
        constructor() {
          sockets.push(this);
        }
      },
    );
    ticket.mockResolvedValue({ ticket: 't', websocket_url: 'ws://127.0.0.1:3171' });
    const { wrapper } = setup();
    const { unmount } = renderHook(() => useChatRealtime(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(sockets).toHaveLength(1);
    unmount();
    expect(sockets[0]?.close).toHaveBeenCalled();
  });
});
