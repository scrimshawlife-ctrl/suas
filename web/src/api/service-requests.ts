import { queryOptions, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';
import { requireData } from './require-data';
import { useSessionToken } from './token-store';

/**
 * `open`: requests the caller can accept (their county, plus bordering once widened).
 * `mine`: requests the caller accepted. `requested`: requests the caller made.
 */
export type Ownership = 'open' | 'mine' | 'requested';

export interface ServiceRequestsFilters {
  ownership: Ownership;
  limit?: number;
  cursor?: string;
}

/** GET /api/v0/service-requests. The key is `[..., 'list', filters]`. */
export function serviceRequestsQueryOptions(filters: ServiceRequestsFilters) {
  return queryOptions({
    queryKey: queryKeys.serviceRequests.list(filters),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/service-requests', {
        params: { query: filters },
      });
      return requireData(data, 'requests');
    },
  });
}

export function useServiceRequests(
  ownership: Ownership,
  options: { limit?: number; cursor?: string } = {},
) {
  const token = useSessionToken();
  return useQuery({
    ...serviceRequestsQueryOptions({ ownership, ...options }),
    enabled: token !== null,
  });
}

/** GET /api/v0/service-requests/{id}: requester or accepter only. */
export function serviceRequestQueryOptions(id: string) {
  return queryOptions({
    queryKey: queryKeys.serviceRequests.detail(id),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/service-requests/{id}', {
        params: { path: { id } },
      });
      return requireData(data, 'request');
    },
  });
}

export function useServiceRequest(id: string | undefined) {
  const token = useSessionToken();
  return useQuery({
    ...serviceRequestQueryOptions(id ?? ''),
    enabled: token !== null && id !== undefined && id !== '',
  });
}

const PAGE_SIZE = 20;

/** Cache key of `useInfiniteServiceRequests`, for mutations that edit the paged list in place. */
export function infiniteServiceRequestsKey(ownership: Ownership) {
  return queryKeys.serviceRequests.list({ ownership, limit: PAGE_SIZE, paged: true });
}

/** The same list as `useServiceRequests`, paged by `next_cursor` for a "Show more" button. */
export function useInfiniteServiceRequests(ownership: Ownership) {
  const token = useSessionToken();
  return useInfiniteQuery({
    queryKey: infiniteServiceRequestsKey(ownership),
    enabled: token !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET('/api/v0/service-requests', {
        params: {
          query: {
            ownership,
            limit: PAGE_SIZE,
            ...(pageParam !== undefined ? { cursor: pageParam } : {}),
          },
        },
      });
      return requireData(data, 'requests');
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}
