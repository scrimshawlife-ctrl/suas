import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, TIMEOUT_CODE } from '../../api/errors';
import { useCommandKey } from '../../api/idempotency';
import { createQueryClient } from '../../app/query-client';
import {
  useDiscardDraft,
  useEditDraft,
  usePublishDraft,
  useResourceDraft,
  useResourceDrafts,
} from './drafts-api';
import { useCreateConsentTemplate } from './consent-templates-api';
import { useLicenceCommand } from './licence-api';
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

function makeWrapper() {
  const queryClient = new QueryClient();
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderEditDraftHook() {
  return renderHook(() => useEditDraft(draft.resource_draft_id), { wrapper: makeWrapper() }).result;
}

/** Renders the draft edit hook; `run` sends one edit and waits for it to settle. */
function renderEditDraft() {
  const result = renderEditDraftHook();
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
  it('is reused after a dropped connection, a timeout or a 409 IDEMPOTENCY_CONFLICT (the first attempt may still run)', async () => {
    client.POST.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new ApiError(408, TIMEOUT_CODE, 'x'))
      .mockRejectedValueOnce(new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'x'))
      .mockResolvedValueOnce({ data: draft })
      .mockResolvedValueOnce({ data: draft });
    const run = renderEditDraft();
    for (let i = 0; i < 5; i += 1) await run();

    expect([1, 2, 3].map(keyOf)).toEqual([keyOf(0), keyOf(0), keyOf(0)]);
    expect(keyOf(4)).not.toBe(keyOf(0)); // the success ended the action
  });

  it('is renewed after a business-rule 409, which the next attempt cannot replay', async () => {
    client.POST.mockRejectedValueOnce(
      new ApiError(409, 'ILLEGAL_TRANSITION', 'x'),
    ).mockResolvedValueOnce({ data: draft });
    const run = renderEditDraft();
    for (let i = 0; i < 2; i += 1) await run();

    expect(keyOf(1)).not.toBe(keyOf(0));
  });

  // The other 409s the admin command routes send (src/catalog/drafts.ts, src/consent/templates.ts,
  // src/identity/licence-review-admin.ts) refuse the action, so none of them keeps the key.
  it.each([
    ['consent template create', 'STALE_STATE'],
    ['consent template create', 'ILLEGAL_TRANSITION'],
    ['licence command', 'LICENCE_REVIEW_DECIDED'],
    ['licence command', 'LICENCE_REVIEW_NOT_READY'],
    ['licence command', 'LICENCE_FINGERPRINT_MISSING'],
    ['licence command', 'LICENCE_ALREADY_USED'],
    ['licence command', 'LICENCE_IDENTITY_MISMATCH'],
  ])('%s: is renewed after a 409 %s', async (hook, code) => {
    client.POST.mockRejectedValueOnce(new ApiError(409, code, 'x')).mockRejectedValueOnce(
      new ApiError(409, code, 'x'),
    );
    const wrapper = makeWrapper();
    const send =
      hook === 'licence command'
        ? renderHook(() => useLicenceCommand('review-1'), { wrapper }).result
        : renderHook(() => useCreateConsentTemplate(), { wrapper }).result;
    const input =
      hook === 'licence command'
        ? ({ name: 'recuse', body: {} } as const)
        : { template_key: 'k', body: 'b' };
    for (let i = 0; i < 2; i += 1) {
      await act(async () => {
        // Each hook takes its own input; the cast only joins the two branches above.
        await (send.current.mutateAsync as (v: typeof input) => Promise<unknown>)(input).catch(
          () => undefined,
        );
      });
    }

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

  // Two overlapping sends on one hook: the older one settling must not renew the newer body's key.
  it('keeps the newer body key when an older send succeeds after it', async () => {
    let finishFirst: (value: { data: typeof draft }) => void = () => undefined;
    client.POST.mockReturnValueOnce(new Promise((resolve) => (finishFirst = resolve)))
      .mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'x'))
      .mockResolvedValueOnce({ data: draft });
    const result = renderEditDraftHook();

    let first: Promise<unknown> = Promise.resolve();
    await act(async () => {
      first = result.current.mutateAsync({ cost: 'Free' });
      await result.current.mutateAsync({ cost: 'Sliding scale' }).catch(() => undefined);
    });
    await act(async () => {
      finishFirst({ data: draft });
      await first;
    });
    await act(async () => {
      await result.current.mutateAsync({ cost: 'Sliding scale' });
    });

    expect(keyOf(1)).not.toBe(keyOf(0));
    expect(keyOf(2)).toBe(keyOf(1)); // the 503 retry replays the second send
  });

  // The client sends with JSON.stringify, which cannot encode a cycle either: the action fails
  // as a rejected mutation before any request, the same way the send itself would.
  it('rejects a body that cannot be encoded without sending it', async () => {
    const body: Record<string, unknown> = { cost: 'Free' };
    body.self = body;
    const result = renderEditDraftHook();

    let error: unknown;
    await act(async () => {
      error = await result.current.mutateAsync(body as { cost: string }).catch((e: unknown) => e);
    });

    expect(error).toBeInstanceOf(TypeError);
    expect(client.POST).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

describe('useCommandKey', () => {
  // canonicalJson fingerprints what JSON.stringify sends, so a Date is its ISO string.
  it('treats a Date like the ISO string JSON.stringify sends for it', () => {
    const at = new Date('2026-11-18T04:34:25Z');
    const { result } = renderHook(() => useCommandKey());
    const first = result.current.headers({ at });
    expect(result.current.headers({ at: at.toISOString() })).toEqual(first);
    expect(result.current.headers({ at: '2026-11-19T00:00:00.000Z' })).not.toEqual(first);
  });
});

// A 409 (the draft moved on) or a 403 (no longer allowed) leaves the cached status stale.
describe.each([
  [409, 'ILLEGAL_TRANSITION'],
  [403, 'FORBIDDEN'],
] as const)('a %i on a draft command', (status, errorCode) => {
  it.each([
    ['publish', usePublishDraft, 'PUBLISHED'],
    ['discard', useDiscardDraft, 'REJECTED'],
  ] as const)('%s: the open draft rereads and shows its state now', async (_, useCommand, now) => {
    client.GET.mockResolvedValueOnce({ data: draft }).mockResolvedValueOnce({
      data: makeDraft({ status: now }),
    });
    client.POST.mockRejectedValue(new ApiError(status, errorCode, 'x'));
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
    client.POST.mockRejectedValue(new ApiError(status, errorCode, 'x'));
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
