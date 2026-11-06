import { infiniteQueryOptions, useInfiniteQuery, type QueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import { useSessionToken } from '../../api/token-store';
import type { ChatThread } from '../../api/types';
import { insertMessage, type ChatMessage, type MessagePage, type MessagesData } from './messages';

/** Prefix of every chat query key (threads and each thread's messages). */
export const CHAT_KEY_ROOT = ['chat'] as const;

/** The thread list shows a 140 character preview, as the server does. */
const PREVIEW_MAX = 140;

/** GET /service-requests/{id}/chat/messages, newest first, paged by `next_cursor`. */
export function chatMessagesQueryOptions(serviceRequestId: string) {
  return infiniteQueryOptions({
    queryKey: queryKeys.chatMessages(serviceRequestId),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }): Promise<MessagePage> => {
      const { data } = await api.GET('/api/v0/service-requests/{id}/chat/messages', {
        params: {
          path: { id: serviceRequestId },
          query: { limit: 50, ...(pageParam !== undefined ? { cursor: pageParam } : {}) },
        },
      });
      return requireData(data, 'messages');
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    // 404 and 409 will not change on retry; a 5xx or a dropped connection gets two more tries.
    retry: (failureCount, error) => !(isApiError(error) && error.status < 500) && failureCount < 2,
  });
}

export function useChatMessages(serviceRequestId: string | undefined) {
  const token = useSessionToken();
  return useInfiniteQuery({
    ...chatMessagesQueryOptions(serviceRequestId ?? ''),
    enabled: token !== null && serviceRequestId !== undefined,
  });
}

/** POST …/chat/messages. The caller owns the key so a retry of the same send reuses it. */
export async function postChatMessage(
  serviceRequestId: string,
  body: string,
  idempotencyKey: string,
): Promise<ChatMessage> {
  const { data } = await api.POST('/api/v0/service-requests/{id}/chat/messages', {
    params: { path: { id: serviceRequestId }, header: { 'Idempotency-Key': idempotencyKey } },
    body: { body },
  });
  return requireData(data, 'message');
}

/** POST /chat/connect-tickets: a one-time ticket and the WebSocket URL to redeem it at. */
export async function issueConnectTicket() {
  const { data } = await api.POST('/api/v0/chat/connect-tickets');
  return requireData(data, 'ticket');
}

/**
 * Puts a message (from a push frame or our own send) into the caches: that thread's
 * messages if they were loaded, and the thread list preview, moved to the top. A message
 * for a thread the list has not seen yet refreshes the list instead. `fromMe` says whether the
 * person sent it (our own send) or the other side did (every push frame).
 */
export function applyMessageToCaches(
  queryClient: QueryClient,
  message: ChatMessage,
  fromMe: boolean,
): void {
  const id = message.service_request_id;
  const messagesKey = queryKeys.chatMessages(id);
  queryClient.setQueryData<MessagesData>(messagesKey, (data) =>
    data === undefined ? data : insertMessage(data, message),
  );
  // A fetch that started before this message was committed may land without it and wipe the
  // insert. Restart it, so data read after the commit wins.
  if (queryClient.isFetching({ queryKey: messagesKey }) > 0) {
    void queryClient.invalidateQueries({ queryKey: messagesKey });
  }

  const threads = queryClient.getQueryData<{ threads: ChatThread[] }>(queryKeys.chatThreads);
  const thread = threads?.threads.find((t) => t.service_request_id === id);
  if (threads === undefined || thread === undefined) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads });
    return;
  }
  // Thread timestamps are millisecond ISO text and message ones have microseconds, so compare as times.
  if (
    thread.last_message_at !== null &&
    Date.parse(thread.last_message_at) > Date.parse(message.created_at)
  ) {
    return;
  }
  const updated: ChatThread = {
    ...thread,
    last_message_body: message.body.slice(0, PREVIEW_MAX),
    last_message_at: message.created_at,
    last_message_from_me: fromMe,
  };
  queryClient.setQueryData(queryKeys.chatThreads, {
    ...threads,
    threads: [updated, ...threads.threads.filter((t) => t.service_request_id !== id)],
  });
  if (queryClient.isFetching({ queryKey: queryKeys.chatThreads }) > 0) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chatThreads });
  }
}
