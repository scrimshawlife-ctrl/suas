import {
  infiniteQueryOptions,
  useInfiniteQuery,
  useQuery,
  type DefaultError,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryOptions,
  type UseInfiniteQueryResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useSessionToken } from './token-store';

/** `useQuery` that stays idle (sends nothing) while there is no session token; `enabled` adds to that. */
export function useSignedInQuery<
  TQueryFnData,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>): UseQueryResult<TData, TError> {
  const token = useSessionToken();
  return useQuery({ ...options, enabled: token === null ? false : (options.enabled ?? true) });
}

/** `useInfiniteQuery` that stays idle while there is no session token; `enabled` adds to that. */
export function useSignedInInfiniteQuery<
  TQueryFnData,
  TError = DefaultError,
  TData = InfiniteData<TQueryFnData>,
  TQueryKey extends QueryKey = QueryKey,
  TPageParam = unknown,
>(
  options: UseInfiniteQueryOptions<TQueryFnData, TError, TData, TQueryKey, TPageParam>,
): UseInfiniteQueryResult<TData, TError> {
  const token = useSessionToken();
  return useInfiniteQuery({
    ...options,
    enabled: token === null ? false : (options.enabled ?? true),
  });
}

/** The `cursor` query parameter of one page: absent on the first page. */
export interface PageCursor {
  cursor?: string;
}

/**
 * Options for a list paged by `next_cursor`: the first page sends no cursor, each later page
 * sends the previous page's `next_cursor`, and a null, missing or empty one is the last page.
 */
export function cursorPages<TPage extends { next_cursor?: string | null }, TKey extends QueryKey>({
  queryKey,
  fetchPage,
}: {
  queryKey: TKey;
  /** Spread `page` into the request's query; it is `{}` on the first page. */
  fetchPage: (page: PageCursor) => Promise<TPage>;
}) {
  return infiniteQueryOptions<
    TPage,
    DefaultError,
    InfiniteData<TPage, string | undefined>,
    TKey,
    string | undefined
  >({
    queryKey,
    initialPageParam: undefined,
    queryFn: ({ pageParam }) => fetchPage(pageParam === undefined ? {} : { cursor: pageParam }),
    getNextPageParam: (last) => last.next_cursor || undefined,
  });
}
