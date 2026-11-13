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
  id_verification: {
    method: 'VA_VETERAN_STATUS',
    status: 'VERIFIED',
    not_confirmed_reason: null,
    verified_at: null,
    failure_class: null,
  },
  open_case: null,
  active_qrf: null,
  categories: [],
  display_name: 'Marcus T.',
  is_admin: true,
} as MeResponse;

/**
 * Every registered route: it must stay on that path, take that screen's document title,
 * and never the not-found or route-error screens. The title is the screen identity while
 * data fetches are still pending. Shared chrome (the crisis strip, Home/Chat/Serve) is
 * not used as the check. `/sign-in` and `/sign-in/code` are left out: they send a
 * signed-in visitor onwards by design (covered in features/public).
 */
const screens: { path: string; title: string }[] = [
  { path: '/', title: 'SUAS · Veterans helping veterans' },
  { path: '/welcome', title: 'Welcome · SUAS' },
  { path: '/verify', title: 'Confirm you served · SUAS' },
  { path: '/crisis', title: 'Immediate resources · SUAS' },
  { path: '/home', title: 'Home · SUAS' },
  { path: '/request', title: 'Request help · SUAS' },
  { path: '/requests', title: 'Your requests · SUAS' },
  { path: '/requests/abc', title: 'Your request · SUAS' },
  { path: '/resources/food', title: 'Food · SUAS' },
  { path: '/check-in', title: 'Check-In · SUAS' },
  { path: '/consents', title: 'What you share · SUAS' },
  { path: '/trusted-contacts', title: 'Trusted contacts · SUAS' },
  { path: '/notifications', title: 'Notifications · SUAS' },
  { path: '/serve', title: 'Serve · SUAS' },
  { path: '/serve/requests/abc', title: 'Case · SUAS' },
  { path: '/chat', title: 'Chat · SUAS' },
  { path: '/chat/abc', title: 'Chat · SUAS' },
  { path: '/admin', title: 'Overview · SUAS Admin' },
  { path: '/admin/drafts', title: 'Resource drafts · SUAS Admin' },
  { path: '/admin/drafts/abc', title: 'Resource draft · SUAS Admin' },
  { path: '/admin/mfa', title: 'Confirm it is you · SUAS' },
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

  it.each(screens)('resolves $path to $title', async ({ path, title }) => {
    const router = renderAt(path);
    await waitFor(() => expect(router.state.navigation.state).toBe('idle'));
    await waitFor(() => expect(document.querySelector('main')).not.toBeNull());
    expect(router.state.location.pathname).toBe(path);
    await waitFor(() => expect(document.title).toBe(title));
    expect(screen.queryByText('We could not find that page.')).toBeNull();
    expect(screen.queryByText('Something went wrong.')).toBeNull();
  });

  it('sets a page title for a screen that is still loading', async () => {
    renderAt('/consents');
    await waitFor(() => expect(document.title).toBe('What you share · SUAS'));
  });

  it('uses the admin suffix for the fallback title of an admin screen', async () => {
    renderAt('/admin');
    await waitFor(() => expect(document.title).toBe('Overview · SUAS Admin'));
  });

  it("lets a screen's own title replace the route's fallback title", async () => {
    renderAt('/');
    // The route fallback is "Veterans helping veterans · SUAS"; the landing page names itself.
    await waitFor(() => expect(document.title).toBe('SUAS · Veterans helping veterans'));
  });

  it('shows the not-found page for an unknown path', async () => {
    renderAt('/nowhere');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'We could not find that page.' }),
    ).toBeInTheDocument();
  });
});
