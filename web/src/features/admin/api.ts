import {
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError, retryServerErrors } from '../../api/errors';
import { useIdempotencyKey } from '../../api/idempotency';
import { queryKeys, resourceKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import type { Schemas } from '../../api/types';
import type { DraftEditRequest, ResourceDraft } from './draft-form';
import type { DraftStatus } from './labels';

export type AdapterCatalogEntry = Schemas['AdapterCatalogEntry'];
export type BuildInfo = Schemas['BuildInfo'];

const buildInfoKeys = resourceKeys('admin-build-info');
const adapterCatalogKeys = resourceKeys('admin-adapter-catalog');

/** `enabled` is false before the MFA step-up, when the route would refuse the request. */
export function useBuildInfo(enabled = true) {
  return useQuery(
    queryOptions({
      queryKey: buildInfoKeys.all,
      enabled,
      queryFn: async () => {
        const { data } = await api.GET('/api/v0/admin/build-info');
        return requireData(data, 'build information');
      },
      retry: retryServerErrors,
    }),
  );
}

export function useAdapterCatalog() {
  return useQuery(
    queryOptions({
      queryKey: adapterCatalogKeys.all,
      queryFn: async () => {
        const { data } = await api.GET('/api/v0/admin/adapter-catalog');
        return requireData(data, 'adapter catalog').adapters;
      },
      retry: retryServerErrors,
    }),
  );
}

const PAGE_SIZE = 20;

/** Drafts for one status, newest first, with a cursor for "Show more". */
export function useResourceDrafts(status: DraftStatus) {
  return useInfiniteQuery({
    queryKey: queryKeys.adminDrafts.list({ status }),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET('/api/v0/admin/resource-drafts', {
        params: {
          query: {
            status,
            limit: PAGE_SIZE,
            ...(pageParam !== undefined ? { cursor: pageParam } : {}),
          },
        },
      });
      return requireData(data, 'drafts');
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    placeholderData: keepPreviousData,
    retry: retryServerErrors,
  });
}

export function useResourceDraft(id: string) {
  return useQuery({
    queryKey: queryKeys.adminDrafts.detail(id),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/admin/resource-drafts/{id}', {
        params: { path: { id } },
      });
      return requireData(data, 'draft');
    },
    retry: retryServerErrors,
  });
}

/**
 * One Idempotency-Key per user action. A retry after a dropped response reuses it; the key
 * is renewed once the action succeeded or the server refused it (4xx), because the next
 * attempt then has a different body.
 */
function useCommandKey() {
  const key = useIdempotencyKey();
  return {
    headers: () => key.headers(),
    settle: (error?: unknown) => {
      if (error === undefined || (isApiError(error) && error.status < 500)) key.renew();
    },
  };
}

export function useExtractDrafts() {
  const queryClient = useQueryClient();
  const key = useCommandKey();
  return useMutation({
    mutationFn: async (body: { source_text: string; source_link: string }) => {
      const { data } = await api.POST('/api/v0/admin/resource-drafts/commands/extract', {
        body,
        headers: key.headers(),
      });
      return requireData(data, 'drafts').drafts;
    },
    onSuccess: () => {
      key.settle();
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.all });
    },
    onError: key.settle,
  });
}

function useDraftCommand<T>(
  id: string,
  run: (headers: Record<string, string>, body?: DraftEditRequest) => Promise<T>,
  toDraft: (result: T) => ResourceDraft,
) {
  const queryClient = useQueryClient();
  const key = useCommandKey();
  return useMutation({
    mutationFn: (body?: DraftEditRequest) => run(key.headers(), body),
    onSuccess: (result) => {
      key.settle();
      queryClient.setQueryData(queryKeys.adminDrafts.detail(id), toDraft(result));
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.lists() });
    },
    onError: (error) => {
      key.settle(error);
      // A 409 means the draft already left "to review": show what it is now.
      if (isApiError(error) && error.status === 409)
        void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.detail(id) });
    },
  });
}

export function useEditDraft(id: string) {
  return useDraftCommand(
    id,
    async (headers, body) => {
      const { data } = await api.POST('/api/v0/admin/resource-drafts/{id}/commands/edit', {
        params: { path: { id } },
        body: body ?? {},
        headers,
      });
      return requireData(data, 'draft');
    },
    (draft) => draft,
  );
}

export function usePublishDraft(id: string) {
  return useDraftCommand(
    id,
    async (headers) => {
      const { data } = await api.POST('/api/v0/admin/resource-drafts/{id}/commands/publish', {
        params: { path: { id } },
        headers,
      });
      return requireData(data, 'published draft');
    },
    (result) => result.draft,
  );
}

export function useDiscardDraft(id: string) {
  return useDraftCommand(
    id,
    async (headers) => {
      const { data } = await api.POST('/api/v0/admin/resource-drafts/{id}/commands/discard', {
        params: { path: { id } },
        headers,
      });
      return requireData(data, 'draft');
    },
    (draft) => draft,
  );
}

/** MFA step-up: start a challenge, then verify the person's response. */
export function useStartMfaChallenge() {
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST('/api/v0/auth/mfa/challenges');
      return requireData(data, 'check');
    },
  });
}

export function useVerifyMfaChallenge() {
  return useMutation({
    mutationFn: async (body: { challenge_id: string; response: string }) => {
      const { data } = await api.POST('/api/v0/auth/mfa/challenges/commands/verify', { body });
      return requireData(data, 'result');
    },
  });
}
