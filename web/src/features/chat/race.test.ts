import { InfiniteQueryObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/keys';
import { applyMessageToCaches, chatMessagesQueryOptions } from './api';
import { toOldestFirst, type ChatMessage } from './messages';

const client = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const message = (n: number): ChatMessage => ({
  chat_message_id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  service_request_id: 'r1',
  sender_user_id: 'u2',
  body: `message ${String(n)}`,
  created_at: `2026-11-04T20:00:0${String(n)}.000000Z`,
});

describe('a push frame that arrives while a fetch is in flight', () => {
  it('is not lost when the older fetch lands without it', async () => {
    let resolveStale: (value: { data: unknown }) => void = () => undefined;
    const stale = new Promise<{ data: unknown }>((resolve) => {
      resolveStale = resolve;
    });
    client.GET.mockReset();
    client.GET.mockReturnValueOnce(stale);
    // The second request is made after the frame was committed, so it includes the message.
    client.GET.mockResolvedValue({
      data: { messages: [message(2), message(1)], next_cursor: null },
    });

    const queryClient = new QueryClient();
    const key = queryKeys.chatMessages('r1');
    queryClient.setQueryData(key, {
      pageParams: [undefined],
      pages: [{ messages: [message(1)], next_cursor: null }],
    });
    // The open conversation observes the key; subscribing starts the (stale) fetch.
    const observer = new InfiniteQueryObserver(queryClient, chatMessagesQueryOptions('r1'));
    const unsubscribe = observer.subscribe(() => undefined);
    // Let the first request start, then the frame arrives.
    await vi.waitFor(() => {
      expect(client.GET).toHaveBeenCalledTimes(1);
    });
    applyMessageToCaches(queryClient, message(2), false);

    // The older request now returns, without the new message.
    resolveStale({ data: { messages: [message(1)], next_cursor: null } });
    await vi.waitFor(() => {
      expect(client.GET).toHaveBeenCalledTimes(2);
      expect(queryClient.isFetching()).toBe(0);
    });

    const data = queryClient.getQueryData<Parameters<typeof toOldestFirst>[0]>(key);
    expect(toOldestFirst(data).map((m) => m.body)).toEqual(['message 1', 'message 2']);
    unsubscribe();
  });
});

describe('chatMessagesQueryOptions', () => {
  it('is keyed per request', () => {
    expect(chatMessagesQueryOptions('r1').queryKey).toEqual(['chat', 'r1', 'messages']);
  });
});
