import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';
import { requireData } from './require-data';
import { useSessionToken } from './token-store';

/** GET /api/v0/chat/threads: the caller's chat threads, as `{ threads }`. */
export function chatThreadsQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.chatThreads,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/chat/threads');
      return requireData(data, 'chats');
    },
  });
}

export function useChatThreads() {
  const token = useSessionToken();
  return useQuery({ ...chatThreadsQueryOptions(), enabled: token !== null });
}
