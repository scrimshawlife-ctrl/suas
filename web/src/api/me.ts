import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from './client';
import { retryServerErrors } from './errors';
import { requireData } from './require-data';
import { queryKeys } from './keys';
import { useSessionToken } from './token-store';

/** GET /api/v0/veterans/me. */
export function meQueryOptions() {
  return queryOptions({
    queryKey: queryKeys.me,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/veterans/me');
      return requireData(data, 'profile');
    },
    staleTime: 30_000,
    retry: retryServerErrors,
  });
}

/** The signed-in person. Idle (no request) while there is no session token. */
export function useMe() {
  const token = useSessionToken();
  return useQuery({ ...meQueryOptions(), enabled: token !== null });
}
