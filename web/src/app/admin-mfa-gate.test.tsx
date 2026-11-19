import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys';
import { tokenStore } from '../api/token-store';
import type { Me } from '../api/types';
import { routes } from './router';

const client = vi.hoisted(() => ({
  GET: vi.fn(() => new Promise<never>(() => {})),
  POST: vi.fn(() => new Promise<never>(() => {})),
}));
vi.mock('../api/client', () => ({ api: client }));

const REVIEW = '/admin/licence-reviews/22222222-2222-4222-8222-222222222222';
const admin = {
  user_id: '11111111-1111-4111-8111-111111111111',
  display_name: 'Marcus T.',
  county: 'SANTA_CLARA',
  is_admin: true,
} as Me;

const licenceReads = () =>
  client.GET.mock.calls.filter(([path]: unknown[]) =>
    String(path).startsWith('/api/v0/admin/licence-reviews'),
  );

function openReview(mfaElevated: boolean) {
  tokenStore.setToken('tok', { mfaElevated });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, admin);
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [REVIEW] })} />
    </QueryClientProvider>,
  );
}

/**
 * The licence review page, its images included, mounts only under RequireMfa. A signed-in
 * admin without step-up must send no licence review request at all, so no response can tell
 * them whether a review id exists (the server also refuses before any lookup).
 */
describe('a licence review link before MFA step-up', () => {
  beforeEach(() => {
    client.GET.mockClear();
  });

  it('shows the step-up screen and sends no licence review request', async () => {
    openReview(false);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Confirm it is you' }),
    ).toBeInTheDocument();
    expect(licenceReads()).toEqual([]);
  });

  it('reads the review once the session is elevated (control)', async () => {
    openReview(true);
    await waitFor(() => expect(licenceReads()).not.toEqual([]));
  });
});
