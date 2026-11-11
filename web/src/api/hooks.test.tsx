import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatThreads } from './chat';
import { ApiError } from './errors';
import { queryKeys } from './keys';
import { useUpdateProfile } from './profile';
import { useServiceRequest, useServiceRequests } from './service-requests';
import { tokenStore } from './token-store';

const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock('./client', () => ({ api: client }));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  tokenStore.clear();
  client.GET.mockReset();
  client.PUT.mockReset();
});

describe('shared read hooks', () => {
  it('stay idle without a session', () => {
    const queryClient = new QueryClient();
    renderHook(() => useChatThreads(), { wrapper: wrapper(queryClient) });
    renderHook(() => useServiceRequests('open'), { wrapper: wrapper(queryClient) });
    expect(client.GET).not.toHaveBeenCalled();
  });

  it('call the documented routes with the right params', async () => {
    tokenStore.setToken('tok');
    client.GET.mockResolvedValue({
      data: { threads: [], service_requests: [], next_cursor: null },
    });
    const queryClient = new QueryClient();
    const options = { wrapper: wrapper(queryClient) };
    const threads = renderHook(() => useChatThreads(), options);
    const mine = renderHook(() => useServiceRequests('mine', { limit: 5 }), options);
    const detail = renderHook(() => useServiceRequest('abc'), options);
    await waitFor(() => {
      expect(threads.result.current.isSuccess).toBe(true);
      expect(mine.result.current.isSuccess).toBe(true);
      expect(detail.result.current.isSuccess).toBe(true);
    });
    expect(client.GET).toHaveBeenCalledWith('/api/v0/chat/threads');
    expect(client.GET).toHaveBeenCalledWith('/api/v0/service-requests', {
      params: { query: { ownership: 'mine', limit: 5 } },
    });
    expect(client.GET).toHaveBeenCalledWith('/api/v0/service-requests/{id}', {
      params: { path: { id: 'abc' } },
    });
    expect(
      queryClient.getQueryData(queryKeys.serviceRequests.list({ ownership: 'mine', limit: 5 })),
    ).toBeDefined();
  });
});

describe('useServiceRequest', () => {
  it('reports a 404 at once instead of retrying it (not yours, or gone)', async () => {
    tokenStore.setToken('tok');
    client.GET.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Resource not found.'));
    // The app's real default, so the 3 retries with back-off would apply without the fix.
    const detail = renderHook(() => useServiceRequest('abc'), {
      wrapper: wrapper(new QueryClient()),
    });
    await waitFor(() => expect(detail.result.current.isError).toBe(true));
    expect(client.GET).toHaveBeenCalledTimes(1);
  });
});

describe('useUpdateProfile', () => {
  it('sends display_name and refreshes me', async () => {
    client.PUT.mockResolvedValue({ data: { display_name: 'Marcus T.' } });
    const queryClient = new QueryClient();
    queryClient.setQueryData(queryKeys.me, { display_name: null });
    const { result } = renderHook(() => useUpdateProfile(), { wrapper: wrapper(queryClient) });
    result.current.mutate('Marcus T.');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.PUT).toHaveBeenCalledWith('/api/v0/veterans/me/profile', {
      body: { display_name: 'Marcus T.' },
    });
    expect(queryClient.getQueryState(queryKeys.me)?.isInvalidated).toBe(true);
  });
});
