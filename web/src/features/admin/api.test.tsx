import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import { useEditDraft, useLicenceReviews } from './api';
import { makeDraft } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const draft = makeDraft();
const keyOf = (call: number) =>
  (client.POST.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers[
    'Idempotency-Key'
  ];

beforeEach(() => client.POST.mockReset());

describe('draft command idempotency key', () => {
  it('is reused after a 5xx and renewed after a success or a 4xx', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'x'))
      .mockRejectedValueOnce(new ApiError(502, 'UPSTREAM', 'x'))
      .mockResolvedValueOnce({ data: draft })
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_FAILED', 'x'))
      .mockResolvedValueOnce({ data: draft });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useEditDraft(draft.resource_draft_id), { wrapper });
    const run = async () => {
      await act(async () => {
        await result.current.mutateAsync({ cost: 'Free' }).catch(() => undefined);
      });
      await waitFor(() => expect(result.current.isPending).toBe(false));
    };
    for (let i = 0; i < 5; i += 1) await run();

    const keys = [0, 1, 2, 3, 4].map(keyOf);
    expect(keys[1]).toBe(keys[0]); // retry after a 5xx
    expect(keys[2]).toBe(keys[0]); // retry after another 5xx
    expect(keys[3]).not.toBe(keys[0]); // new action after the success
    expect(keys[4]).not.toBe(keys[3]); // new action after a 4xx
  });
});

describe('licence review queue', () => {
  it('sends nothing without a session token, then loads once signed in', async () => {
    tokenStore.clear();
    client.GET.mockReset().mockResolvedValue({
      data: { reviews: [], limit: 20, next_cursor: null },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLicenceReviews(), { wrapper });
    expect(result.current.fetchStatus).toBe('idle');
    expect(client.GET).not.toHaveBeenCalled();
    act(() => tokenStore.setToken('tok', { mfaElevated: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.GET).toHaveBeenCalledTimes(1);
  });
});
