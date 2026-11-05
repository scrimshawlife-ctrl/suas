import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import VerifyPage from '../request/VerifyPage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function renderVerify() {
  tokenStore.setToken('tok');
  const router = createMemoryRouter([{ path: '/verify', element: <VerifyPage /> }], {
    initialEntries: ['/verify'],
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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
