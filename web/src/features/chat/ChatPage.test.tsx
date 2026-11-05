import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { createQueryClient } from '../../app/query-client';
import { tokenStore } from '../../api/token-store';
import ChatPage from './ChatPage';
import { outbox } from './outbox';
import { seenStore } from './unread';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const ME = '11111111-1111-4111-8111-111111111111';
const THEM = '22222222-2222-4222-8222-222222222222';
const REQ = '33333333-3333-4333-8333-333333333333';
const CLOSED = '44444444-4444-4444-8444-444444444444';

const threads = {
  threads: [
    {
      service_request_id: REQ,
      category: 'TRANSPORTATION',
      summary: 'Ride to a clinic appointment',
      counterpart_display_name: 'Marcus T.',
      last_message_body: 'Perfect, see you then.',
      last_message_at: '2026-11-04T20:02:00.000Z',
      closed: false,
      role: 'REQUESTER',
      last_message_from_me: false,
    },
    {
      service_request_id: CLOSED,
      category: 'FOOD',
      summary: 'Groceries for the week',
      counterpart_display_name: 'Ray K.',
      last_message_body: 'Thanks again.',
      last_message_at: '2026-11-03T20:14:00.000Z',
      closed: true,
      role: 'ACCEPTER',
      last_message_from_me: false,
    },
  ],
};

const message = (n: number, sender: string, body: string) => ({
  chat_message_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  service_request_id: REQ,
  sender_user_id: sender,
  body,
  created_at: `2026-11-04T20:0${String(n)}:00.000000Z`,
});

interface Routes_ {
  messages?: (query: { cursor?: string }) => unknown;
  /** The person's side of the open conversation; the closed one is always the other side. */
  role?: 'REQUESTER' | 'ACCEPTER';
  /** Issue connect tickets (the test supplies a WebSocket) instead of answering 503. */
  realtime?: boolean;
}

function mockApi({ messages, role = 'REQUESTER', realtime = false }: Routes_ = {}) {
  client.GET.mockImplementation(
    (path: string, init?: { params?: { query?: { cursor?: string } } }) => {
      switch (path) {
        case '/api/v0/veterans/me':
          return Promise.resolve({ data: { user_id: ME } });
        case '/api/v0/chat/threads':
          return Promise.resolve({
            data: {
              threads: threads.threads.map((t) =>
                t.service_request_id === REQ ? { ...t, role } : t,
              ),
            },
          });
        case '/api/v0/service-requests/{id}/chat/messages': {
          const result = messages?.(init?.params?.query ?? {});
          if (result instanceof Error) return Promise.reject(result);
          return Promise.resolve({ data: result });
        }
        default:
          return Promise.reject(new Error(`unexpected GET ${path}`));
      }
    },
  );
  // Live updates unavailable: the page falls back to polling and opens no socket.
  client.POST.mockImplementation((path: string) => {
    if (path !== '/api/v0/chat/connect-tickets') {
      return Promise.reject(new Error(`unexpected POST ${path}`));
    }
    return realtime
      ? Promise.resolve({ data: { ticket: 't', websocket_url: 'ws://127.0.0.1:3171' } })
      : Promise.reject(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'));
  });
}

function renderChat(at: string, queryClient = new QueryClient()) {
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[at]}>
        <Routes>
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:serviceRequestId" element={<ChatPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const page1 = {
  messages: [message(4, THEM, 'Perfect, see you then.'), message(3, ME, 'Got it.')],
  next_cursor: 'older',
};
const page2 = {
  messages: [message(2, THEM, 'Yes, 9:30 works.'), message(1, ME, 'Hi Marcus.')],
  next_cursor: null,
};

beforeEach(() => {
  outbox.clear();
  tokenStore.setToken('tok');
  client.GET.mockReset();
  client.POST.mockReset();
});

describe('thread list', () => {
  it('lists threads with the current one marked and a closed one labelled', async () => {
    mockApi({ messages: () => page2 });
    renderChat(`/chat/${REQ}`);
    const nav = await screen.findByRole('navigation', { name: 'Conversations' });
    const current = await within(nav).findByRole('link', { name: /Marcus T\./ });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current).toHaveTextContent('Ride to a clinic appointment');
    expect(current).toHaveTextContent('Perfect, see you then.');
    const closed = within(nav).getByRole('link', { name: /Ray K\./ });
    expect(closed).not.toHaveAttribute('aria-current');
    expect(closed).toHaveTextContent('Groceries for the week, closed');
  });

  it('says so when there are no conversations', async () => {
    mockApi();
    client.GET.mockImplementation((path: string) =>
      Promise.resolve({
        data: path === '/api/v0/chat/threads' ? { threads: [] } : { user_id: ME },
      }),
    );
    renderChat('/chat');
    expect(await screen.findByText('You have no conversations yet.')).toBeInTheDocument();
  });
});

describe('conversation', () => {
  it('shows messages oldest to newest, marks outgoing, and has no call or attach control', async () => {
    mockApi({ messages: (q) => (q.cursor === undefined ? page1 : page2) });
    const user = userEvent.setup();
    renderChat(`/chat/${REQ}`);

    await screen.findByRole('list', { name: 'Messages' });
    expect(screen.getByRole('button', { name: 'Load earlier messages' })).toBeInTheDocument();
    expect(screen.queryByText('Chat is open for this request.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    await screen.findByText('Hi Marcus.');
    const bodies = within(screen.getByRole('list', { name: 'Messages' }))
      .getAllByRole('paragraph')
      .map((p) => p.textContent)
      .filter((t) => /Hi Marcus|9:30|Got it|Perfect/.test(t));
    expect(bodies).toEqual(['Hi Marcus.', 'Yes, 9:30 works.', 'Got it.', 'Perfect, see you then.']);
    expect(screen.getByText('Chat is open for this request.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument();

    // Outgoing bubbles are the signed-in person's; the meta line names the sender.
    expect(screen.getByText('Got it.').className).toMatch(/bg-service-blue/);
    expect(screen.getByText('Yes, 9:30 works.').className).not.toMatch(/bg-service-blue/);
    expect(screen.getAllByText(/^You,/)).toHaveLength(2);
    expect(screen.getAllByText(/^Marcus T\.,/)).toHaveLength(2);
    expect(screen.queryByLabelText(/call/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/attach/i)).not.toBeInTheDocument();
  });

  it('links to the request as its requester and to the case as its accepter', async () => {
    mockApi({ messages: () => page2 });
    const first = renderChat(`/chat/${REQ}`);
    expect(
      await screen.findByRole('link', { name: 'Ride to a clinic appointment' }),
    ).toHaveAttribute('href', `/requests/${REQ}`);
    first.unmount();

    mockApi({ messages: () => page2, role: 'ACCEPTER' });
    renderChat(`/chat/${REQ}`);
    expect(
      await screen.findByRole('link', { name: 'Ride to a clinic appointment' }),
    ).toHaveAttribute('href', `/serve/requests/${REQ}`);
  });

  it('explains a request that has not been accepted', async () => {
    mockApi({
      messages: () => new ApiError(409, 'CHAT_UNAVAILABLE', 'Chat opens once someone accepts.'),
    });
    renderChat(`/chat/${REQ}`);
    expect(
      await screen.findByText('Chat opens once someone accepts your request.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('explains a conversation that does not exist', async () => {
    mockApi({ messages: () => new ApiError(404, 'NOT_FOUND', 'Not found.') });
    renderChat(`/chat/${REQ}`);
    expect(await screen.findByText("We couldn't find that conversation.")).toBeInTheDocument();
  });
});

describe('sending', () => {
  it('appends optimistically, keeps the failed message, and retries with the same key', async () => {
    mockApi({ messages: () => page2 });
    const user = userEvent.setup();
    renderChat(`/chat/${REQ}`);
    const box = await screen.findByLabelText('Message Marcus T.');
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute('aria-disabled', 'true');

    const sendKeys: string[] = [];
    let attempt = 0;
    client.POST.mockImplementation(
      (
        path: string,
        init?: { params?: { header?: Record<string, string> }; body?: { body: string } },
      ) => {
        if (path === '/api/v0/chat/connect-tickets') {
          return Promise.reject(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'));
        }
        sendKeys.push(init?.params?.header?.['Idempotency-Key'] ?? '');
        attempt += 1;
        if (attempt === 1) return Promise.reject(new ApiError(500, 'INTERNAL', 'Server error.'));
        return Promise.resolve({
          data: { ...message(5, ME, init?.body?.body ?? ''), replayed: false },
        });
      },
    );

    await user.type(box, '  See you at 9:30  ');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByText('Not sent.')).toBeInTheDocument();
    expect(screen.getByText('See you at 9:30')).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith(
      '/api/v0/service-requests/{id}/chat/messages',
      expect.objectContaining({ body: { body: 'See you at 9:30' } }),
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(screen.queryByText('Not sent.')).not.toBeInTheDocument();
    });
    expect(sendKeys).toHaveLength(2);
    expect(sendKeys[0]).not.toBe('');
    expect(sendKeys[1]).toBe(sendKeys[0]);
    expect(
      within(screen.getByRole('list', { name: 'Messages' })).getAllByText('See you at 9:30'),
    ).toHaveLength(1);
  });
});

describe('failures', () => {
  it('asks once for a conversation that is not found or not open yet, with the real client defaults', async () => {
    for (const error of [
      new ApiError(404, 'NOT_FOUND', 'Not found.'),
      new ApiError(409, 'CHAT_UNAVAILABLE', 'Not accepted.'),
    ]) {
      client.GET.mockReset();
      mockApi({ messages: () => error });
      const view = renderChat(`/chat/${REQ}`, createQueryClient());
      await screen.findByRole('alert');
      const asked = client.GET.mock.calls.filter(
        ([path]) => path === '/api/v0/service-requests/{id}/chat/messages',
      );
      expect(asked).toHaveLength(1);
      view.unmount();
    }
  });

  it('keeps what is on screen when loading earlier messages fails, and loads them on the next try', async () => {
    let failOnce = true;
    mockApi({
      messages: (q) => {
        if (q.cursor === undefined) return page1;
        if (failOnce) {
          failOnce = false;
          return new ApiError(400, 'VALIDATION_FAILED', 'Bad cursor.');
        }
        return page2;
      },
    });
    const user = userEvent.setup();
    renderChat(`/chat/${REQ}`);
    await user.click(await screen.findByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText("We couldn't load earlier messages.")).toBeInTheDocument();
    expect(screen.getByText('Got it.')).toBeInTheDocument();
    expect(screen.queryByText('Chat is open for this request.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load earlier messages' }));
    expect(await screen.findByText('Hi Marcus.')).toBeInTheDocument();
    expect(screen.queryByText("We couldn't load earlier messages.")).not.toBeInTheDocument();
  });

  it('shows a send that the server refused (4xx) as not sent, without retrying by itself', async () => {
    mockApi({ messages: () => page2 });
    const user = userEvent.setup();
    renderChat(`/chat/${REQ}`);
    const box = await screen.findByLabelText('Message Marcus T.');
    client.POST.mockImplementation((path: string) =>
      path === '/api/v0/chat/connect-tickets'
        ? Promise.reject(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'))
        : Promise.reject(new ApiError(422, 'VALIDATION_FAILED', 'Body must not be empty.')),
    );
    await user.type(box, 'hello');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Not sent.')).toBeInTheDocument();
    const sends = client.POST.mock.calls.filter(
      ([path]) => path !== '/api/v0/chat/connect-tickets',
    );
    expect(sends).toHaveLength(1);
  });

  it('still shows "Not sent." for a send that failed after leaving the conversation and coming back', async () => {
    mockApi({ messages: () => page2 });
    const user = userEvent.setup();
    const first = renderChat(`/chat/${REQ}`);
    const box = await screen.findByLabelText('Message Marcus T.');
    let fail: (error: Error) => void = () => undefined;
    client.POST.mockImplementation((path: string) =>
      path === '/api/v0/chat/connect-tickets'
        ? Promise.reject(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'))
        : new Promise((_resolve, reject) => {
            fail = reject;
          }),
    );
    await user.type(box, 'on my way');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sending')).toBeInTheDocument();
    first.unmount();

    fail(new ApiError(500, 'INTERNAL', 'Server error.'));
    await waitFor(() => {
      expect(outbox.get(REQ)[0]?.status).toBe('failed');
    });
    renderChat(`/chat/${REQ}`);
    expect(await screen.findByText('on my way')).toBeInTheDocument();
    expect(screen.getByText('Not sent.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('forgets unsent messages when the person signs out', async () => {
    mockApi({ messages: () => page2 });
    const user = userEvent.setup();
    renderChat(`/chat/${REQ}`);
    const box = await screen.findByLabelText('Message Marcus T.');
    client.POST.mockImplementation((path: string) =>
      path === '/api/v0/chat/connect-tickets'
        ? Promise.reject(new ApiError(503, 'CHAT_REALTIME_UNAVAILABLE', 'No push.'))
        : Promise.reject(new ApiError(500, 'INTERNAL', 'Server error.')),
    );
    await user.type(box, 'draft');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Not sent.');
    act(() => {
      tokenStore.signOut();
    });
    expect(outbox.get(REQ)).toHaveLength(0);
  });
});

describe('live frame', () => {
  it('reaches the open conversation, the thread preview and the live region, and marks it read', async () => {
    const sockets: { onmessage: ((e: { data: string }) => void) | null }[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        onmessage: ((e: { data: string }) => void) | null = null;
        close = vi.fn();
        constructor() {
          sockets.push(this);
        }
      },
    );
    mockApi({ messages: () => page2, realtime: true });
    const markSeen = vi.spyOn(seenStore, 'markSeen');
    renderChat(`/chat/${REQ}`);
    await screen.findByText('Hi Marcus.');
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    const created = '2026-11-04T20:09:00.000000Z';
    act(() => {
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          type: 'chat.message',
          message: {
            chat_message_id: '00000000-0000-4000-8000-0000000000f9',
            service_request_id: REQ,
            sender_user_id: THEM,
            body: 'Running five minutes late',
            created_at: created,
          },
        }),
      });
    });

    const list = screen.getByRole('list', { name: 'Messages' });
    expect(await within(list).findByText('Running five minutes late')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Conversations' });
    expect(await within(nav).findByText('Running five minutes late')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('New message from Marcus T.');
    });
    expect(markSeen).toHaveBeenCalledWith(REQ, Date.parse(created));
    vi.unstubAllGlobals();
  });
});
