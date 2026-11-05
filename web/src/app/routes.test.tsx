import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../api/keys';
import type { MeResponse } from '../api/supplement';
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

/** Every route in the table, with the heading its placeholder page renders. */
const table: [path: string, heading: string][] = [
  ['/', 'Landing'],
  ['/sign-in', 'Sign in'],
  ['/sign-in/code', 'Enter code'],
  ['/welcome', 'Profile setup'],
  ['/verify', 'Confirm you served'],
  ['/crisis', 'Immediate resources'],
  ['/home', 'Home'],
  ['/request', 'Request help'],
  ['/requests/abc', 'Request status'],
  ['/resources/FOOD', 'Resources'],
  ['/check-in', 'Check-In'],
  ['/consents', 'Consents'],
  ['/trusted-contacts', 'Trusted contacts'],
  ['/notifications', 'Notifications'],
  ['/serve', 'Serve'],
  ['/serve/requests/abc', 'Case'],
  ['/chat', 'Chat'],
  ['/chat/abc', 'Chat'],
  ['/admin', 'Overview'],
  ['/admin/drafts', 'Resource drafts'],
  ['/admin/drafts/abc', 'Resource draft'],
  ['/admin/mfa', 'Confirm it is you'],
  ['/nowhere', 'We could not find that page.'],
];

describe('route table', () => {
  it.each(table)('renders %s for a verified, MFA-elevated admin', async (path, heading) => {
    tokenStore.setToken('tok', { mfaElevated: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.me, admin);
    const router = createMemoryRouter(routes, { initialEntries: [path] });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
  });
});
