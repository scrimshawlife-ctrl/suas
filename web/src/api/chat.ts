import type { InfiniteData } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';
import { cursorPages, useSignedInInfiniteQuery } from './queries';
import { requireData } from './require-data';
import type { Schemas } from './types';

/** The server's list maximum: one page holds up to 100 threads; older ones come by cursor. */
const THREAD_LIMIT = 100;

export type ChatThreadPages = InfiniteData<Schemas['ChatThreadList'], string | undefined>;

/** GET /api/v0/chat/threads: the caller's chat threads, most recent activity first, paged. */
export function chatThreadsQueryOptions() {
  return cursorPages({
    queryKey: queryKeys.chatThreads,
    fetchPage: async (page) => {
      const { data } = await api.GET('/api/v0/chat/threads', {
        params: { query: { limit: THREAD_LIMIT, ...page } },
      });
      return requireData(data, 'chats');
    },
  });
}

export function useChatThreads() {
  return useSignedInInfiniteQuery(chatThreadsQueryOptions());
}
