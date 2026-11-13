import { infiniteQueryOptions, useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';
import { requireData } from './require-data';
import { useSessionToken } from './token-store';
import type { Schemas } from './types';

/** The server's list maximum: one page holds up to 100 threads; older ones come by cursor. */
const THREAD_LIMIT = 100;

export type ChatThreadPages = InfiniteData<Schemas['ChatThreadList'], string | undefined>;

/** GET /api/v0/chat/threads: the caller's chat threads, most recent activity first, paged. */
export function chatThreadsQueryOptions() {
  return infiniteQueryOptions({
    queryKey: queryKeys.chatThreads,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET('/api/v0/chat/threads', {
        params: {
          query: {
            limit: THREAD_LIMIT,
            ...(pageParam !== undefined ? { cursor: pageParam } : {}),
          },
        },
      });
      return requireData(data, 'chats');
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useChatThreads() {
  const token = useSessionToken();
  return useInfiniteQuery({ ...chatThreadsQueryOptions(), enabled: token !== null });
}
