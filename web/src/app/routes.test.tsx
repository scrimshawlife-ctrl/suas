import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys';
import type { Me as MeResponse } from '../api/types';
import { tokenStore } from '../api/token-store';
import { routes } from './router';

const admin = {
  user_id: '11111111-1111-4111-8111-111111111111',
  status: 'ACTIVE',
  enrolled_channels: { email: true, phone: false },
  county: 'SANTA_CLARA',
  id_verification: { method: 'ID_SCAN_SELFIE', status: 'VERIFIED', verified_at: null },
  open_case: null,
  active_qrf: null,
  categories: [],
  display_name: 'Marcus T.',
  is_admin: true,
} as MeResponse;

/**
 * Every registered route: it must resolve to its own page (no redirect) and never to the
 * not-found or route-error screens. Page content is each feature's own tests' job, so this
 * table survives pages replacing their placeholders. `/sign-in` and `/sign-in/code` are left
 * out: they send a signed-in visitor onwards by design (covered in features/public).
 */
const paths: string[] = [
  '/',
  '/welcome',
  '/verify',
  '/crisis',
  '/home',
  '/request',
  '/requests/abc',
  '/resources/food',
  '/check-in',
  '/consents',
  '/trusted-contacts',
  '/notifications',
  '/serve',
  '/serve/requests/abc',
  '/chat',
  '/chat/abc',
  '/admin',
  '/admin/drafts',
  '/admin/drafts/abc',
  '/admin/mfa',
];

function renderAt(path: string) {
  tokenStore.setToken('tok', { mfaElevated: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, admin);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('route table', () => {
  beforeEach(() => {
    // Pages fetch on mount; keep them pending so the test checks routing, not data.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>(() => {})),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(paths)('resolves %s to its page for a verified, MFA-elevated admin', async (path) => {
    const router = renderAt(path);
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
    await waitFor(() => expect(document.querySelector('main')).not.toBeNull());
    expect(router.state.location.pathname).toBe(path);
    expect(screen.queryByText('We could not find that page.')).toBeNull();
    expect(screen.queryByText('Something went wrong.')).toBeNull();
  });

  it('sets a page title for a screen that is still loading', async () => {
    renderAt('/consents');
    await waitFor(() => expect(document.title).toBe('What you share · SUAS'));
  });

  it('shows the not-found page for an unknown path', async () => {
    renderAt('/nowhere');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not find that page.' }),
    ).toBeInTheDocument();
  });
});
