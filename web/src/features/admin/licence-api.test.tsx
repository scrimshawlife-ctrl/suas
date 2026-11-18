import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import { useAdminLicenceReview, useLicenceCommand, useLicenceReviews } from './licence-api';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

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

  // The client gate is the session only; MFA is the server's (gate() in
  // src/http/routes/admin-licence-reviews.ts) and the admin route guard's. The queue read is
  // sent, and the 403 MFA_REQUIRED it gets is the query's error, shown with no data.
  it('with a session that is not MFA-elevated, the queue read gets the server 403 and no rows', async () => {
    tokenStore.setToken('tok', { mfaElevated: false });
    client.GET.mockReset().mockRejectedValue(
      new ApiError(403, 'MFA_REQUIRED', 'Confirm it is you.'),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useLicenceReviews(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 403, code: 'MFA_REQUIRED' });
    expect(result.current.data).toBeUndefined();
    expect(client.GET).toHaveBeenCalledTimes(1);
  });
});

describe('a licence command that fails', () => {
  // A 409 (decided elsewhere) or 403 (recused, second reviewer) means the review moved on, so
  // the open page rereads it; a 5xx changed nothing it knows of, so it keeps what it shows.
  it.each([
    [409, 'LICENCE_REVIEW_DECIDED', 2],
    [403, 'SECOND_REVIEWER_REQUIRED', 2],
    [503, 'UNAVAILABLE', 1],
  ])('answered %i %s reads the review %i time(s)', async (status, code, reads) => {
    client.GET.mockReset().mockResolvedValue({ data: { review_id: 'review-1' } });
    client.POST.mockReset().mockRejectedValue(new ApiError(status, code, 'x'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({ review: useAdminLicenceReview('review-1'), command: useLicenceCommand('review-1') }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.review.isSuccess).toBe(true));
    await act(async () => {
      await result.current.command.mutateAsync({ name: 'recuse', body: {} }).catch(() => undefined);
    });
    await waitFor(() => expect(client.GET).toHaveBeenCalledTimes(reads));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.GET).toHaveBeenCalledTimes(reads);
  });
});
