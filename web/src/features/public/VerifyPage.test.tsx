import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import VerifyPage from '../request/VerifyPage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function renderVerify(): { unmount: () => void } {
  tokenStore.setToken('tok');
  const router = createMemoryRouter([{ path: '/verify', element: <VerifyPage /> }], {
    initialEntries: ['/verify'],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const check = (status: string) => ({
  data: { method: 'ID_SCAN_SELFIE', status, verified_at: null },
});

beforeEach(() => {
  tokenStore.clear();
  client.GET.mockReset();
  client.POST.mockReset();
});

describe('Verify page', () => {
  it('has one start button and no camera or upload', async () => {
    client.GET.mockResolvedValue(check('NOT_STARTED'));
    renderVerify();
    expect(await screen.findByRole('button', { name: 'Start verification' })).toBeInTheDocument();
    expect(screen.queryByText(/camera|upload/i)).not.toBeInTheDocument();
  });

  it('says so honestly and offers Serve when the provider is unavailable', async () => {
    client.GET.mockResolvedValue(check('NOT_STARTED'));
    client.POST.mockRejectedValue(
      new ApiError(503, 'ID_VERIFICATION_UNAVAILABLE', 'ID verification is not available.'),
    );
    renderVerify();
    await userEvent.click(await screen.findByRole('button', { name: 'Start verification' }));
    expect(
      await screen.findByRole('heading', { name: 'ID checks are not available right now' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'You can still help others' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  });

  it('shows a waiting message while pending', async () => {
    client.GET.mockResolvedValue(check('PENDING'));
    renderVerify();
    expect(await screen.findByText(/Your check is in progress/)).toBeInTheDocument();
  });

  it('continues to /home once verified', async () => {
    client.GET.mockResolvedValue(check('VERIFIED'));
    renderVerify();
    expect(await screen.findByRole('link', { name: 'Continue' })).toHaveAttribute('href', '/home');
  });
});

describe('Verify page states', () => {
  it('lets a person try again after NOT_CONFIRMED and still offers Serve', async () => {
    client.GET.mockResolvedValue(check('NOT_CONFIRMED'));
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: 'We could not confirm your ID' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  });

  it('offers no retry after REVOKED, only Serve', async () => {
    client.GET.mockResolvedValue(check('REVOKED'));
    renderVerify();
    expect(
      await screen.findByRole('heading', { name: 'Your ID check is no longer valid' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /try again|start verification/i })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to Serve' })).toHaveAttribute('href', '/serve');
  });
});

describe('Verify polling', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

  it('refetches every 4 seconds while PENDING', async () => {
    client.GET.mockResolvedValue(check('PENDING'));
    renderVerify();
    await tick(0);
    expect(client.GET).toHaveBeenCalledTimes(1);
    await tick(4000);
    expect(client.GET).toHaveBeenCalledTimes(2);
    await tick(4000);
    expect(client.GET).toHaveBeenCalledTimes(3);
  });

  it.each(['VERIFIED', 'NOT_CONFIRMED'])('stops polling once %s', async (final) => {
    client.GET.mockResolvedValueOnce(check('PENDING')).mockResolvedValue(check(final));
    renderVerify();
    await tick(0);
    await tick(4000);
    const calls = client.GET.mock.calls.length;
    await tick(20000);
    expect(client.GET).toHaveBeenCalledTimes(calls);
  });

  it('stops polling when the page closes', async () => {
    client.GET.mockResolvedValue(check('PENDING'));
    const { unmount } = renderVerify();
    await tick(0);
    unmount();
    const calls = client.GET.mock.calls.length;
    await tick(20000);
    expect(client.GET).toHaveBeenCalledTimes(calls);
  });

  it('keeps showing the last status when a poll fails', async () => {
    client.GET.mockResolvedValueOnce(check('PENDING')).mockRejectedValue(
      new ApiError(500, 'INTERNAL', 'Server error'),
    );
    renderVerify();
    await tick(0);
    await tick(4000);
    expect(screen.getByText(/Your check is in progress/)).toBeInTheDocument();
    expect(screen.queryByText('We could not load your check status.')).toBeNull();
  });
});
