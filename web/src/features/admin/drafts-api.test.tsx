import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { createQueryClient } from '../../app/query-client';
import {
  useDiscardDraft,
  useEditDraft,
  usePublishDraft,
  useResourceDraft,
  useResourceDrafts,
} from './drafts-api';
import { makeDraft } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const draft = makeDraft();
const keyOf = (call: number) =>
  (client.POST.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers[
    'Idempotency-Key'
  ];

beforeEach(() => {
  client.GET.mockReset();
  client.POST.mockReset();
});

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

describe('a 409 on a draft command', () => {
  it.each([
    ['publish', usePublishDraft, 'PUBLISHED'],
    ['discard', useDiscardDraft, 'REJECTED'],
  ] as const)('%s: the open draft rereads and shows its state now', async (_, useCommand, now) => {
    client.GET.mockResolvedValueOnce({ data: draft }).mockResolvedValueOnce({
      data: makeDraft({ status: now }),
    });
    client.POST.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'x'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        query: useResourceDraft(draft.resource_draft_id),
        command: useCommand(draft.resource_draft_id),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.query.data?.status).toBe('DRAFT'));

    await act(async () => {
      await result.current.command.mutateAsync(undefined).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.query.data?.status).toBe(now));
    expect(client.GET).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['publish', usePublishDraft],
    ['discard', useDiscardDraft],
  ] as const)('%s: the draft queue rereads when it is opened next', async (_, useCommand) => {
    const LIST = '/api/v0/admin/resource-drafts';
    client.GET.mockResolvedValue({
      data: {
        builder: { available: true, message: null },
        drafts: [draft],
        limit: 20,
        next_cursor: null,
      },
    });
    client.POST.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'x'));
    // The app's client: a list read in the last 15 s is shown from cache unless invalidated.
    const queryClient = createQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const listReads = () => client.GET.mock.calls.filter(([path]) => path === LIST).length;
    const queue = renderHook(() => useResourceDrafts('DRAFT'), { wrapper });
    await waitFor(() => expect(queue.result.current.isSuccess).toBe(true));
    queue.unmount();

    const { result } = renderHook(() => useCommand(draft.resource_draft_id), { wrapper });
    await act(async () => {
      await result.current.mutateAsync(undefined).catch(() => undefined);
    });
    renderHook(() => useResourceDrafts('DRAFT'), { wrapper });
    await waitFor(() => expect(listReads()).toBe(2));
  });
});
