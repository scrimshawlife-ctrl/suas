import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { createQueryClient } from '../../app/query-client';
import { tokenStore } from '../../api/token-store';
import ChatPage from './ChatPage';
import { outbox } from './outbox';

// R18.1–R18.3 (contributor proposal, not released): the helper's private assistance and the
// requester's notice, driven through the chat page with the API client mocked.
const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const ASSIST = '/api/v0/service-requests/{id}/chat/assist';

interface Setup {
  role?: 'REQUESTER' | 'ACCEPTER';
  enabled?: boolean;
  releasedAt?: string;
  /** Answers POST …/chat/assist; an Error rejects. */
  assist?: (kind: string) => unknown;
}

function mockApi({ role = 'ACCEPTER', enabled = true, releasedAt, assist }: Setup = {}) {
  client.GET.mockImplementation((path: string) => {
    switch (path) {
      case '/api/v0/veterans/me':
        return Promise.resolve({ data: { user_id: ME } });
      case '/api/v0/chat/threads':
        return Promise.resolve({
          data: {
            threads: [
              {
                service_request_id: REQ,
                category: 'TRANSPORTATION',
                summary: 'Ride to a clinic appointment',
                counterpart_display_name: 'Marcus T.',
                last_message_body: 'Can you drive me Tuesday?',
                last_message_at: '2026-11-04T20:01:00.000Z',
                closed: false,
                role,
                last_message_from_me: false,
                chat_assist_enabled: enabled,
                ...(releasedAt ? { released_at: releasedAt } : {}),
              },
            ],
            next_cursor: null,
          },
        });
      case '/api/v0/service-requests/{id}/chat/messages':
        return Promise.resolve({
          data: {
            messages: [
              {
                chat_message_id: '00000000-0000-4000-8000-000000000001',
                service_request_id: REQ,
                sender_user_id: THEM,
                body: 'Can you drive me Tuesday?',
                created_at: '2026-11-04T20:01:00.000000Z',
              },
            ],
            next_cursor: null,
          },
        });
      default:
        return Promise.reject(new Error(`unexpected GET ${path}`));
    }
  });
  client.POST.mockImplementation((path: string, init?: { body?: { kind?: string } }) => {
    if (path === ASSIST && assist !== undefined) {
      const result = assist(init?.body?.kind ?? '');
      if (result instanceof Error) return Promise.reject(result);
      return result instanceof Promise ? result : Promise.resolve({ data: result });
    }
    if (path === '/api/v0/chat/connect-tickets') {
      return Promise.reject(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'));
    }
    return Promise.reject(new Error(`unexpected POST ${path}`));
  });
}

function renderChat() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[`/chat/${REQ}`]}>
        <Routes>
          <Route path="/chat/:serviceRequestId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const box = () => screen.getByRole('textbox', { name: 'Message Marcus T.' });
const assistCalls = () => client.POST.mock.calls.filter(([path]) => path === ASSIST);

beforeEach(() => {
  outbox.clear();
  tokenStore.setToken('tok');
  client.GET.mockReset();
  client.POST.mockReset();
});

describe('chat assistance', () => {
  it('gives the helper both buttons and the requester only the notice line', async () => {
    mockApi();
    const first = renderChat();
    expect(await screen.findByRole('button', { name: 'Catch me up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest a reply' })).toBeInTheDocument();
    expect(screen.queryByText(/Your helper may use an AI assistant/)).not.toBeInTheDocument();
    first.unmount();

    mockApi({ role: 'REQUESTER' });
    renderChat();
    expect(
      await screen.findByText(
        'Your helper may use an AI assistant that reads this chat to suggest replies. Messages are always sent by your helper.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Catch me up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest a reply' })).not.toBeInTheDocument();
  });

  it('shows no assistance when it is off or the thread is read-only', async () => {
    mockApi({ enabled: false });
    const first = renderChat();
    await screen.findByRole('textbox', { name: 'Message Marcus T.' });
    expect(screen.queryByRole('button', { name: 'Suggest a reply' })).not.toBeInTheDocument();
    first.unmount();

    mockApi({ releasedAt: '2026-11-05T10:00:00.000Z' });
    renderChat();
    await screen.findByText('This helper released the request. This chat is closed.');
    expect(screen.queryByRole('button', { name: 'Catch me up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest a reply' })).not.toBeInTheDocument();
  });

  it('fills the box with a suggestion, appends to typed text, and never sends', async () => {
    let answer: (value: unknown) => void = () => undefined;
    mockApi({
      assist: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    const user = userEvent.setup();
    renderChat();
    await user.type(await screen.findByRole('textbox', { name: 'Message Marcus T.' }), 'Hi.');

    await user.click(screen.getByRole('button', { name: 'Suggest a reply' }));
    const thinking = screen.getByRole('button', { name: 'Thinking…' });
    expect(thinking).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Catch me up' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(thinking);
    answer({ data: { outcome: 'SUGGESTION', text: 'Tuesday works. What time?' } });

    expect(await screen.findByText('AI suggestion. Check it before you send.')).toBeInTheDocument();
    expect(box()).toHaveValue('Hi.\nTuesday works. What time?');
    expect(assistCalls()).toHaveLength(1);
    expect(assistCalls()[0]?.[1]).toMatchObject({ body: { kind: 'SUGGEST_REPLY' } });
    expect(
      client.POST.mock.calls.some(
        ([path]) => path === '/api/v0/service-requests/{id}/chat/messages',
      ),
    ).toBe(false);
  });

  it('shows the catch-up summary in a private card that closes', async () => {
    mockApi({ assist: () => ({ outcome: 'CATCH_UP', text: 'Marcus needs a ride Tuesday.' }) });
    const user = userEvent.setup();
    renderChat();
    await user.click(await screen.findByRole('button', { name: 'Catch me up' }));

    const card = await screen.findByRole('region', { name: 'AI summary, only you can see this' });
    expect(within(card).getByText('Marcus needs a ride Tuesday.')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Close summary' }));
    expect(
      screen.queryByRole('region', { name: 'AI summary, only you can see this' }),
    ).not.toBeInTheDocument();
    expect(box()).toHaveValue('');
  });

  it('turns assistance off and shows the crisis panel on CRISIS_SUPPORT', async () => {
    mockApi({ assist: () => ({ outcome: 'CRISIS_SUPPORT', notice: 'Placeholder banner.' }) });
    const user = userEvent.setup();
    renderChat();
    await user.click(await screen.findByRole('button', { name: 'Suggest a reply' }));

    expect(
      await screen.findByRole('heading', { name: 'Need help right now?' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Suggestions are off for this conversation. You can share these resources with the Veteran.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suggest a reply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Catch me up' })).not.toBeInTheDocument();
    expect(box()).toHaveValue('');
  });

  it.each([
    [
      new ApiError(429, 'RATE_LIMITED', 'Slow down.', 600),
      "You've asked for a lot of suggestions. Try again later.",
    ],
    [
      new ApiError(503, 'CHAT_ASSIST_UNAVAILABLE', 'Off.'),
      "Suggestions aren't available right now.",
    ],
  ])('explains a %s failure', async (error, text) => {
    mockApi({ assist: () => error });
    const user = userEvent.setup();
    renderChat();
    await user.click(await screen.findByRole('button', { name: 'Suggest a reply' }));
    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Suggest a reply' })).not.toHaveAttribute(
      'aria-disabled',
    );
  });
});
