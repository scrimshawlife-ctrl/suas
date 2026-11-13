import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { queryKeys } from '../../api/keys';
import type { ChatThreadPages } from '../../api/chat';
import type { ChatThread } from '../../api/types';
import { applyMessageToCaches } from './api';
import { toOldestFirst, type ChatMessage, type MessagesData } from './messages';
import { allThreads } from './threads';

const message = (id: string, request: string, at: string, body = 'hello'): ChatMessage => ({
  chat_message_id: id,
  service_request_id: request,
  sender_user_id: 'u2',
  body,
  created_at: at,
});

const thread = (request: string, at: string | null): ChatThread => ({
  service_request_id: request,
  category: 'TRANSPORTATION',
  summary: 'Ride',
  counterpart_display_name: 'Marcus T.',
  last_message_body: 'old',
  last_message_at: at,
  closed: false,
  role: 'REQUESTER',
  last_message_from_me: null,
});

/** Seeds the thread list as pages, one array per page. */
function setThreads(queryClient: QueryClient, ...pages: ChatThread[][]) {
  queryClient.setQueryData<ChatThreadPages>(queryKeys.chatThreads, {
    pageParams: pages.map((_, index) => (index === 0 ? undefined : `c${String(index)}`)),
    pages: pages.map((threads, index) => ({
      threads,
      next_cursor: index === pages.length - 1 ? null : `c${String(index + 1)}`,
    })),
  });
}

const listed = (queryClient: QueryClient) =>
  queryClient.getQueryData<ChatThreadPages>(queryKeys.chatThreads);

function seeded() {
  const queryClient = new QueryClient();
  setThreads(queryClient, [
    thread('r1', '2026-11-04T20:00:00.000Z'),
    thread('r2', '2026-11-04T21:00:00.000Z'),
  ]);
  queryClient.setQueryData<MessagesData>(queryKeys.chatMessages('r1'), {
    pageParams: [undefined],
    pages: [
      {
        messages: [message('a', 'r1', '2026-11-04T20:00:00.000000Z', 'old')],
        next_cursor: null,
      },
    ],
  });
  return queryClient;
}

describe('applyMessageToCaches', () => {
  it('adds a pushed message to its thread and moves the thread to the top', () => {
    const queryClient = seeded();
    applyMessageToCaches(
      queryClient,
      message('b', 'r1', '2026-11-04T22:00:00.000000Z', 'newest'),
      false,
    );

    const messages = queryClient.getQueryData<MessagesData>(queryKeys.chatMessages('r1'));
    expect(toOldestFirst(messages).map((m) => m.body)).toEqual(['old', 'newest']);
    const threads = { threads: allThreads(listed(queryClient)) ?? [] };
    expect(threads?.threads.map((t) => t.service_request_id)).toEqual(['r1', 'r2']);
    expect(threads?.threads[0]?.last_message_body).toBe('newest');
    expect(threads?.threads[0]?.last_message_from_me).toBe(false);
  });

  it('does not duplicate a message delivered twice (push, then refetch or send)', () => {
    const queryClient = seeded();
    const pushed = message('b', 'r1', '2026-11-04T22:00:00.000000Z');
    applyMessageToCaches(queryClient, pushed, false);
    applyMessageToCaches(queryClient, pushed, false);
    const messages = queryClient.getQueryData<MessagesData>(queryKeys.chatMessages('r1'));
    expect(toOldestFirst(messages)).toHaveLength(2);
  });

  it('leaves a thread whose messages were never loaded alone and still bumps the list', () => {
    const queryClient = seeded();
    applyMessageToCaches(
      queryClient,
      message('c', 'r2', '2026-11-04T22:30:00.000000Z', 'ping'),
      true,
    );
    expect(queryClient.getQueryData(queryKeys.chatMessages('r2'))).toBeUndefined();
    const threads = { threads: allThreads(listed(queryClient)) ?? [] };
    expect(threads?.threads[0]?.service_request_id).toBe('r2');
    expect(threads?.threads[0]?.last_message_body).toBe('ping');
    // The flag follows the newest message, so unread stays right after either side writes.
    expect(threads?.threads[0]?.last_message_from_me).toBe(true);
  });

  it('moves the live thread, not the closed one, when a request has both', () => {
    const queryClient = seeded();
    // The server names every thread, so the two rows of r1 stay distinct in the list.
    const closed = {
      ...thread('r1', '2026-11-04T23:00:00.000Z'),
      chat_thread_id: 't-closed',
      released_at: '2026-11-04T23:30:00Z',
    };
    const liveOne = { ...thread('r1', '2026-11-04T20:00:00.000Z'), chat_thread_id: 't-live' };
    setThreads(queryClient, [closed, thread('r2', null), liveOne]);
    applyMessageToCaches(
      queryClient,
      message('e', 'r1', '2026-11-05T01:00:00.000000Z', 'new'),
      false,
    );
    const threads = { threads: allThreads(listed(queryClient)) ?? [] };
    expect(threads?.threads).toHaveLength(3);
    expect(threads?.threads[0]?.last_message_body).toBe('new');
    expect(threads?.threads[0]?.released_at).toBeUndefined();
    expect(threads?.threads.find((t) => t.released_at !== undefined)?.last_message_body).toBe(
      'old',
    );
  });

  it('moves a thread from an older page to the top of the first page', () => {
    const queryClient = new QueryClient();
    setThreads(
      queryClient,
      [thread('r1', '2026-11-04T21:00:00.000Z')],
      [thread('r2', '2026-11-04T20:00:00.000Z'), thread('r3', '2026-11-04T19:00:00.000Z')],
    );
    applyMessageToCaches(queryClient, message('f', 'r2', '2026-11-04T22:00:00.000000Z'), false);
    const pages = listed(queryClient)?.pages.map((page) =>
      page.threads.map((t) => t.service_request_id),
    );
    expect(pages).toEqual([['r2', 'r1'], ['r3']]);
    expect(listed(queryClient)?.pages[0]?.next_cursor).toBe('c1');
  });

  it('refreshes the list for a thread it has not seen yet', () => {
    const queryClient = seeded();
    applyMessageToCaches(queryClient, message('d', 'r3', '2026-11-04T23:00:00.000000Z'), false);
    expect(queryClient.getQueryState(queryKeys.chatThreads)?.isInvalidated).toBe(true);
  });
});
