import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/errors';
import { useCommandKey } from '../../api/idempotency';
import { queryKeys } from '../../api/keys';
import { cursorPages } from '../../api/queries';
import { requireData } from '../../api/require-data';
import type { DraftEditRequest, ResourceDraft } from './draft-form';
import type { DraftStatus } from './labels';

const PAGE_SIZE = 20;

/** Drafts for one status, newest first, with a cursor for "Show more". */
export function useResourceDrafts(status: DraftStatus) {
  return useInfiniteQuery({
    ...cursorPages({
      queryKey: queryKeys.adminDrafts.list({ status }),
      fetchPage: async (page) => {
        const { data } = await api.GET('/api/v0/admin/resource-drafts', {
          params: { query: { status, limit: PAGE_SIZE, ...page } },
        });
        return requireData(data, 'drafts');
      },
    }),
    placeholderData: keepPreviousData,
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
  });
}

export function useExtractDrafts() {
  const queryClient = useQueryClient();
  const key = useCommandKey();
  return useMutation({
    mutationFn: async (body: { source_text: string; source_link: string }) => {
      const { data } = await api.POST('/api/v0/admin/resource-drafts/commands/extract', {
        body,
        headers: key.headers(body),
      });
      return requireData(data, 'drafts').drafts;
    },
    onSuccess: (_drafts, body) => {
      key.settle(body);
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.all });
    },
    onError: (error, body) => key.settle(body, error),
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
    mutationFn: (body?: DraftEditRequest) => run(key.headers(body), body),
    onSuccess: (result, body) => {
      key.settle(body);
      queryClient.setQueryData(queryKeys.adminDrafts.detail(id), toDraft(result));
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.lists() });
    },
    onError: (error, body) => {
      key.settle(body, error);
      // A 409 (the draft already left "to review") or a 403 (this admin may no longer act on it):
      // reread it here and in the lists, which would otherwise show it from cache as still to review.
      if (isApiError(error) && (error.status === 409 || error.status === 403)) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.detail(id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.adminDrafts.lists() });
      }
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
