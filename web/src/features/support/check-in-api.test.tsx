import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../../api/token-store';
import { supportKeys, useCheckIn, useResumableCheckIn, useSaveCheckInAnswer } from './api';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  tokenStore.setToken('tok', { mfaElevated: false });
  client.GET.mockReset();
  client.POST.mockReset();
});

describe('Check-In resume hooks', () => {
  it('reads the unfinished Check-In as one item, or null when the list is empty', async () => {
    client.GET.mockResolvedValue({ data: { check_ins: [{ check_in_id: 'c1' }] } });
    const first = renderHook(() => useResumableCheckIn(), {
      wrapper: wrapper(new QueryClient()),
    });
    await waitFor(() => expect(first.result.current.data).toEqual({ check_in_id: 'c1' }));
    expect(client.GET).toHaveBeenCalledWith('/api/v0/check-ins', {
      params: { query: { status: 'IN_PROGRESS' } },
    });

    client.GET.mockResolvedValue({ data: { check_ins: [] } });
    const none = renderHook(() => useResumableCheckIn(), { wrapper: wrapper(new QueryClient()) });
    await waitFor(() => expect(none.result.current.data).toBeNull());
  });

  it('stays idle when disabled, and without an id for the detail', () => {
    renderHook(() => useResumableCheckIn(false), { wrapper: wrapper(new QueryClient()) });
    renderHook(() => useCheckIn(undefined), { wrapper: wrapper(new QueryClient()) });
    expect(client.GET).not.toHaveBeenCalled();
  });

  it('adds a saved question to the cached detail so a later resume skips it', async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(supportKeys.checkIns.detail('c1'), {
      check_in_id: 'c1',
      questions: [],
      answered_question_ids: ['q1'],
    });
    client.POST.mockResolvedValue({ data: { check_in_id: 'c1' } });
    const { result } = renderHook(() => useSaveCheckInAnswer('c1'), {
      wrapper: wrapper(queryClient),
    });
    await act(() => result.current.mutateAsync({ questionId: 'q2', answerOptionId: 'o2' }));
    await act(() => result.current.mutateAsync({ questionId: 'q2', answerOptionId: 'o3' }));
    expect(
      queryClient.getQueryData<{ answered_question_ids: string[] }>(
        supportKeys.checkIns.detail('c1'),
      )?.answered_question_ids,
    ).toEqual(['q1', 'q2']);
  });
});
