import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TIMEOUT_CODE } from '../../api/errors';
import { useEditDraft } from './api';
import { makeDraft } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const draft = makeDraft();
const keyOf = (call: number) =>
  (client.POST.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers[
    'Idempotency-Key'
  ];

beforeEach(() => client.POST.mockReset());

/** Renders the draft edit hook; `run` sends one edit and waits for it to settle. */
function renderEditDraft() {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useEditDraft(draft.resource_draft_id), { wrapper });
  return async (cost = 'Free') => {
    await act(async () => {
      await result.current.mutateAsync({ cost }).catch(() => undefined);
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  };
}

describe('draft command idempotency key', () => {
  it('is reused after a 5xx and renewed after a success or a 4xx', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'x'))
      .mockRejectedValueOnce(new ApiError(502, 'UPSTREAM', 'x'))
      .mockResolvedValueOnce({ data: draft })
      .mockRejectedValueOnce(new ApiError(400, 'VALIDATION_FAILED', 'x'))
      .mockResolvedValueOnce({ data: draft });
    const run = renderEditDraft();
    for (let i = 0; i < 5; i += 1) await run();

    const keys = [0, 1, 2, 3, 4].map(keyOf);
    expect(keys[1]).toBe(keys[0]); // retry after a 5xx
    expect(keys[2]).toBe(keys[0]); // retry after another 5xx
    expect(keys[3]).not.toBe(keys[0]); // new action after the success
    expect(keys[4]).not.toBe(keys[3]); // new action after a 4xx
  });

  // API.md §7 rules 3 and 5: only the first key can replay an action that may have run.
  it('is reused after a timeout or a 409 IDEMPOTENCY_CONFLICT (the first attempt may still run)', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(408, TIMEOUT_CODE, 'x'))
      .mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'x'))
      .mockResolvedValueOnce({ data: draft });
    const run = renderEditDraft();
    for (let i = 0; i < 3; i += 1) await run();

    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).toBe(keyOf(0));
  });

  it('is renewed after a business-rule 409, which the next attempt cannot replay', async () => {
    client.POST.mockRejectedValueOnce(
      new ApiError(409, 'ILLEGAL_TRANSITION', 'x'),
    ).mockResolvedValueOnce({ data: draft });
    const run = renderEditDraft();
    for (let i = 0; i < 2; i += 1) await run();

    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  it('is renewed when the body changes, so a kept key never meets a different body', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'x')).mockResolvedValueOnce({
      data: draft,
    });
    const run = renderEditDraft();
    await run('Free');
    await run('Sliding scale');

    expect(keyOf(1)).not.toBe(keyOf(0));
  });
});
