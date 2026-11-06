import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { tokenStore } from '../api/token-store';
import { routes } from './router';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../api/client', () => ({ api: client }));

const REQ = '33333333-3333-4333-8333-333333333333';

function mockApi() {
  client.GET.mockImplementation((path: string) => {
    switch (path) {
      case '/api/v0/veterans/me':
        return Promise.resolve({
          data: {
            user_id: '11111111-1111-4111-8111-111111111111',
            status: 'ACTIVE',
            enrolled_channels: { email: true, phone: false },
            county: 'SANTA_CLARA',
            display_name: 'Dee R.',
            is_admin: false,
            id_verification: { method: 'ID_SCAN_SELFIE', status: 'VERIFIED', verified_at: null },
            open_case: null,
            active_qrf: null,
            categories: [],
          },
        });
      case '/api/v0/chat/threads':
        return Promise.resolve({
          data: {
            threads: [
              {
                service_request_id: REQ,
                category: 'PEER_SUPPORT',
                summary: 'Someone to talk to',
                counterpart_display_name: 'Taylor R.',
                last_message_body: 'Hello',
                last_message_at: '2026-11-04T20:02:00.000Z',
                closed: false,
                role: 'ACCEPTER',
                last_message_from_me: false,
              },
            ],
          },
        });
      case '/api/v0/service-requests/{id}/chat/messages':
        return Promise.resolve({ data: { messages: [], next_cursor: null } });
      default:
        return Promise.reject(new Error(`unexpected GET ${path}`));
    }
  });
  client.POST.mockRejectedValue(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'));
}

describe('chat routes', () => {
  beforeEach(() => {
    tokenStore.setToken('tok');
    mockApi();
    // Two-pane layout (861 px and up).
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('picking a thread keeps the same chat screen: the list is not rebuilt and focus stays on the link', async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(routes, { initialEntries: ['/chat'] });
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    const link = await screen.findByRole('link', { name: /Taylor R\./ });
    link.focus();

    await user.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe(`/chat/${REQ}`));
    await screen.findByRole('heading', { level: 2, name: 'Taylor R.' });

    // Same DOM nodes: ChatPage was not remounted, so scroll, live updates and focus survive.
    expect(screen.getByRole('navigation', { name: 'Conversations' })).toBe(nav);
    expect(screen.getByRole('link', { name: /Taylor R\./ })).toBe(link);
    expect(link).toHaveFocus();
  });
});
