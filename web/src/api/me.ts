import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from './client';
import { ApiError, isApiError } from './errors';
import { queryKeys } from './keys';
import { useSessionToken } from './token-store';

/** GET /api/v0/veterans/me. */
export function meQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/veterans/me');
      if (data === undefined)
        throw new ApiError(502, 'EMPTY_RESPONSE', 'The server sent no profile.');
      return data;
    },
    staleTime: 30_000,
    // A 4xx will not change on retry; a 5xx or a dropped connection gets two more tries.
    retry: (failureCount, error) => !(isApiError(error) && error.status < 500) && failureCount < 2,
  });
}

/** The signed-in person. Idle (no request) while there is no session token. */
export function useMe() {
  const token = useSessionToken();
  return useQuery({ ...meQueryOptions(), enabled: token !== null });
}
