import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { type Designation, useLicenceDecision } from './useLicenceDecision';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const id = '22222222-2222-4222-8222-222222222222';
const DETAIL = '/api/v0/admin/licence-reviews/{id}';
const review = { review_id: id, status: 'AWAITING_REVIEW', conflicting_review: null };
const detailReads = () => client.GET.mock.calls.filter(([path]) => path === DETAIL).length;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useLicenceDecision(id), { wrapper });
  /** Asks for the review again, as a list or decision refresh would. */
  const reread = () =>
    act(() =>
      queryClient.invalidateQueries({ queryKey: queryKeys.adminLicenceReviews.detail(id) }),
    );
  return { ...hook, reread };
}

/** Sends one command through `run`, the way the dialogs do, and waits for it to settle. */
async function send(
  result: ReturnType<typeof setup>['result'],
  command: Parameters<ReturnType<typeof useLicenceDecision>['command']['mutateAsync']>[0],
) {
  const sent = client.POST.mock.calls.length;
  act(() => result.current.run(() => result.current.command.mutateAsync(command)));
  await waitFor(() => expect(client.POST.mock.calls.length).toBe(sent + 1));
  await waitFor(() => expect(result.current.command.isPending).toBe(false));
}

beforeEach(() => {
  client.GET.mockReset();
  client.POST.mockReset();
  client.GET.mockResolvedValue({ data: review });
});

describe('useLicenceDecision designation answer', () => {
  it('"no" opens the decline dialog with NO_VETERAN_DESIGNATION chosen', () => {
    const { result } = setup();
    act(() => result.current.answerDesignation('no'));
    expect(result.current.designation).toBe('no');
    expect(result.current.reason).toBe('NO_VETERAN_DESIGNATION');
    expect(result.current.dialog).toBe('decline');
  });

  it('"yes" reveals the reading and opens no dialog', () => {
    const { result } = setup();
    act(() => result.current.answerDesignation('yes'));
    expect(result.current.designation).toBe('yes');
    expect(result.current.dialog).toBeNull();
  });

  it('ignores a value that is neither yes nor no, so it never reveals the reading', () => {
    const { result } = setup();
    act(() => result.current.answerDesignation('maybe' as Designation));
    expect(result.current.designation).toBeNull();
    expect(result.current.dialog).toBeNull();
  });
});

describe('useLicenceDecision commands', () => {
  it('a successful command closes the dialog', async () => {
    client.POST.mockResolvedValue({ data: { ...review, images: { front: true } } });
    const { result } = setup();
    act(() => result.current.setDialog('approve'));
    await send(result, {
      name: 'approve',
      body: {
        designation_visible: true,
        checklist: { selfie_matches: true, security_features: true, whole_card: true },
      },
    });
    expect(result.current.dialog).toBeNull();
  });

  it('a failed command keeps the dialog open with the error on the mutation', async () => {
    client.POST.mockRejectedValue(new ApiError(409, 'LICENCE_REVIEW_DECIDED', 'x'));
    const { result } = setup();
    act(() => result.current.setDialog('decline'));
    await send(result, { name: 'decline', body: { reason: 'OTHER' } });
    expect(result.current.dialog).toBe('decline');
    expect(result.current.command.isError).toBe(true);
  });

  it('a failed command leaves a debug trace in a dev build', async () => {
    const failure = new ApiError(409, 'LICENCE_REVIEW_DECIDED', 'x');
    client.POST.mockRejectedValue(failure);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const { result } = setup();
    await send(result, { name: 'decline', body: { reason: 'OTHER' } });
    expect(debug).toHaveBeenCalledWith('Licence command failed', failure);
    debug.mockRestore();
  });

  it('close clears the dialog, the reason error and the last failure', async () => {
    client.POST.mockRejectedValue(new ApiError(500, 'INTERNAL', 'x'));
    const { result } = setup();
    act(() => {
      result.current.setDialog('revoke');
      result.current.setReasonError('Choose a reason.');
    });
    await send(result, { name: 'revoke', body: { reason: 'FRAUD' } });
    act(() => result.current.close());
    await waitFor(() => expect(result.current.command.isIdle).toBe(true));
    expect(result.current.dialog).toBeNull();
    expect(result.current.reasonError).toBeUndefined();
  });

  // With no conflicting review the conflict command has no id; it must fail without a request
  // rather than POST to /licence-reviews//commands/revoke.
  it('the conflict command sends nothing when the review has no conflicting review', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    act(() => result.current.setDialog('revoke_conflict'));
    act(() =>
      result.current.run(() =>
        result.current.conflictCommand.mutateAsync({ name: 'revoke', body: { reason: 'FRAUD' } }),
      ),
    );
    await waitFor(() => expect(result.current.conflictCommand.isError).toBe(true));
    expect(client.POST).not.toHaveBeenCalled();
    expect(result.current.dialog).toBe('revoke_conflict');
  });
});

describe('useLicenceDecision after a decision', () => {
  // The command's answer is the server's fresh read of the review (the route reads it after the
  // change), so it replaces the cached one at once, and the review stays readable to its admin.
  it.each([
    [
      'approve',
      {
        name: 'approve',
        body: {
          designation_visible: true,
          checklist: { selfie_matches: true, security_features: true, whole_card: true },
        },
      },
      'AWAITING_CONFIRMATION',
    ],
    ['decline', { name: 'decline', body: { reason: 'OTHER' } }, 'DECLINED'],
    ['revoke', { name: 'revoke', body: { reason: 'FRAUD' } }, 'REVOKED'],
  ] as const)(
    'after a successful %s shows the server answer, then reads the review again',
    async (_name, command, status) => {
      client.POST.mockResolvedValue({ data: { ...review, status, images: { front: false } } });
      const { result, reread } = setup();
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
      await send(result, command);
      expect(result.current.query.data?.status).toBe(status);
      expect(detailReads()).toBe(1);

      client.GET.mockResolvedValue({ data: { ...review, status } });
      await reread();
      await waitFor(() => expect(detailReads()).toBe(2));
      expect(result.current.query.data?.status).toBe(status);
    },
  );
});

describe('useLicenceDecision after a recuse', () => {
  // The hook never navigates, so this is also the page when leaving for the queue fails: it
  // stays open with no review data and sends no read the server would answer 403.
  it('stops reading the review once a recuse succeeded, and holds none of it, while still open', async () => {
    client.POST.mockResolvedValue({ data: undefined });
    const { result, reread } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await send(result, { name: 'recuse', body: {} });
    await reread();
    await reread();
    expect(result.current.query.fetchStatus).toBe('idle');
    expect(result.current.query.data).toBeUndefined();
    expect(result.current.query.isError).toBe(false);
    expect(detailReads()).toBe(1);
  });

  it('keeps reading the review when the recuse failed', async () => {
    client.POST.mockRejectedValue(new ApiError(500, 'INTERNAL', 'x'));
    const { result, reread } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await send(result, { name: 'recuse', body: {} });
    await reread();
    await waitFor(() => expect(detailReads()).toBe(2));
  });

  it('a failed recuse followed by a successful decline is not a recuse', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'x')).mockResolvedValueOnce({
      data: { ...review, status: 'DECLINED', images: { front: false } },
    });
    const { result, reread } = setup();
    await waitFor(() => expect(result.current.query.isSuccess).toBe(true));
    await send(result, { name: 'recuse', body: {} });
    await send(result, { name: 'decline', body: { reason: 'OTHER' } });
    expect(result.current.command.isSuccess).toBe(true);
    await reread();
    await waitFor(() => expect(detailReads()).toBe(2));
  });
});
