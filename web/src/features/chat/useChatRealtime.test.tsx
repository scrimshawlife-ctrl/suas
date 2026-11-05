import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import {
  LIVE_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  shouldRestart,
  STALE_AFTER_HIDDEN_MS,
  useChatRealtime,
} from './useChatRealtime';

const ticket = vi.hoisted(() => vi.fn());
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issueConnectTicket: ticket,
}));

function setup(options: { strict?: boolean } = {}) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => {
    const inner = <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return options.strict === true ? <StrictMode>{inner}</StrictMode> : inner;
  };
  return { invalidate, wrapper };
}

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
  static get open() {
    return FakeWebSocket.all.filter((socket) => !socket.closed);
  }
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}
const flush = (ms = 0) => act(() => vi.advanceTimersByTimeAsync(ms));

beforeEach(() => {
  vi.useFakeTimers();
  tokenStore.setToken('tok');
  ticket.mockReset();
  FakeWebSocket.all = [];
  vi.stubGlobal('WebSocket', FakeWebSocket);
});
afterEach(() => {
  tokenStore.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setVisibility('visible');
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

describe('useChatRealtime socket lifecycle', () => {
  const goodTicket = () =>
    ticket.mockResolvedValue({ ticket: 't', websocket_url: 'ws://127.0.0.1:3171' });

  it('closes an open socket on sign-out', async () => {
    goodTicket();
    const { wrapper } = setup();
    renderHook(() => useChatRealtime(), { wrapper });
    await flush();
    FakeWebSocket.all[0]?.onopen?.();
    expect(FakeWebSocket.open).toHaveLength(1);
    act(() => {
      tokenStore.signOut();
    });
    expect(FakeWebSocket.open).toHaveLength(0);
  });

  it('leaves exactly one open socket after a StrictMode double mount', async () => {
    goodTicket();
    const { wrapper } = setup({ strict: true });
    renderHook(() => useChatRealtime(), { wrapper });
    await flush();
    await flush(5000);
    expect(FakeWebSocket.open).toHaveLength(1);
  });

  it('refetches every 60 s while live, as a safety net', async () => {
    goodTicket();
    const { invalidate, wrapper } = setup();
    renderHook(() => useChatRealtime(), { wrapper });
    await flush();
    FakeWebSocket.all[0]?.onopen?.();
    invalidate.mockClear();
    await flush(POLL_INTERVAL_MS * 2);
    expect(invalidate).not.toHaveBeenCalled();
    await flush(LIVE_POLL_INTERVAL_MS);
    expect(invalidate).toHaveBeenCalled();
  });

  it('restarts a reconnecting socket as soon as the window regains focus', async () => {
    ticket.mockRejectedValueOnce(new TypeError('network'));
    ticket.mockResolvedValue({ ticket: 't2', websocket_url: 'ws://127.0.0.1:3171' });
    const { wrapper } = setup();
    const { result } = renderHook(() => useChatRealtime(), { wrapper });
    await flush();
    expect(result.current).toBe('reconnecting');
    expect(ticket).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.all[0]?.url).toContain('ticket=t2');
  });

  it('restarts a live socket after the tab was hidden for more than 30 s, not after a short while', async () => {
    goodTicket();
    const { wrapper } = setup();
    renderHook(() => useChatRealtime(), { wrapper });
    await flush();
    FakeWebSocket.all[0]?.onopen?.();

    act(() => {
      setVisibility('hidden');
    });
    await flush(5000);
    act(() => {
      setVisibility('visible');
    });
    await flush();
    expect(ticket).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibility('hidden');
    });
    await flush(STALE_AFTER_HIDDEN_MS + 1000);
    act(() => {
      setVisibility('visible');
    });
    await flush();
    expect(ticket).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.all[0]?.closed).toBe(true);
    expect(FakeWebSocket.open).toHaveLength(1);
  });

  it('restarts when the network comes back', async () => {
    goodTicket();
    const { wrapper } = setup();
    renderHook(() => useChatRealtime(), { wrapper });
    await flush();
    FakeWebSocket.all[0]?.onopen?.();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await flush();
    expect(ticket).toHaveBeenCalledTimes(2);
  });
});

describe('shouldRestart', () => {
  it('restarts for reconnecting, a long hidden spell or the network returning, not otherwise', () => {
    const quiet = { status: 'live', hiddenForMs: 1000, networkBack: false } as const;
    expect(shouldRestart(quiet)).toBe(false);
    expect(shouldRestart({ ...quiet, status: 'reconnecting' })).toBe(true);
    expect(shouldRestart({ ...quiet, hiddenForMs: STALE_AFTER_HIDDEN_MS + 1 })).toBe(true);
    expect(shouldRestart({ ...quiet, networkBack: true })).toBe(true);
  });
});
