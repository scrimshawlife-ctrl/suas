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

export type AdminLicenceReview = Schemas['AdminLicenceReview'];
export type LicenceImageSide = 'front' | 'back' | 'selfie';

const licenceKeys = queryKeys.adminLicenceReviews;

/**
 * Open licence reviews, oldest first (suas-specs #73 R10.1 proposal, L5.1). The server leaves
 * out the admin's own reviews, recusals and disputes of reviews they decided; rows carry no names.
 */
export function useLicenceReviews() {
  return useInfiniteQuery({
    queryKey: licenceKeys.lists(),
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam }) => {
      const { data } = await api.GET('/api/v0/admin/licence-reviews', {
        params: {
          query: { limit: PAGE_SIZE, ...(pageParam !== undefined ? { cursor: pageParam } : {}) },
        },
      });
      return requireData(data, 'licence reviews');
    },
    getNextPageParam: (last) => last.next_cursor ?? undefined,
    retry: retryServerErrors,
  });
}

export function useAdminLicenceReview(id: string) {
  return useQuery({
    queryKey: licenceKeys.detail(id),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/admin/licence-reviews/{id}', {
        params: { path: { id } },
      });
      return requireData(data, 'licence review');
    },
    retry: retryServerErrors,
  });
}

/**
 * One review image through the bearer-auth client (a plain img src cannot send the token).
 * Never kept once the page closes; the server sends it no-store as well (L5.2).
 */
export function useLicenceImage(id: string, side: LicenceImageSide, enabled: boolean) {
  return useQuery({
    queryKey: [...licenceKeys.detail(id), 'image', side],
    enabled,
    gcTime: 0,
    staleTime: Infinity,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/admin/licence-reviews/{id}/images/{side}', {
        params: { path: { id, side } },
        parseAs: 'blob',
      });
      return requireData(data, 'licence image');
    },
    retry: retryServerErrors,
  });
}

/** The by-eye checklist and the designation answer, all true, sent with approve and confirm. */
export interface LicenceApproval {
  designation_visible: true;
  checklist: { selfie_matches: true; security_features: true; whole_card: true };
}

type LicenceCommand =
  | { name: 'approve' | 'confirm'; body: LicenceApproval }
  | { name: 'decline'; body: { reason: Schemas['LicenceDeclineReason'] } }
  | { name: 'revoke'; body: { reason: Schemas['LicenceRevokeReason'] } }
  | { name: 'recuse'; body: Record<string, never> };

/**
 * POST /admin/licence-reviews/{id}/commands/{approve|confirm|decline|revoke|recuse} with one
 * Idempotency-Key per action (required by the route). A decision drops any image this page
 * holds, since the server deletes them; a 409 or 403 rereads the review to show where it is.
 */
export function useLicenceCommand(id: string) {
  const queryClient = useQueryClient();
  const key = useCommandKey();
  return useMutation({
    mutationFn: async (command: LicenceCommand) => {
      const options = { params: { path: { id } }, headers: key.headers() };
      switch (command.name) {
        case 'approve': {
          const { data } = await api.POST('/api/v0/admin/licence-reviews/{id}/commands/approve', {
            ...options,
            body: command.body,
          });
          return requireData(data, 'licence review');
        }
        case 'confirm': {
          const { data } = await api.POST('/api/v0/admin/licence-reviews/{id}/commands/confirm', {
            ...options,
            body: command.body,
          });
          return requireData(data, 'licence review');
        }
        case 'decline': {
          const { data } = await api.POST('/api/v0/admin/licence-reviews/{id}/commands/decline', {
            ...options,
            body: command.body,
          });
          return requireData(data, 'licence review');
        }
        case 'revoke': {
          const { data } = await api.POST('/api/v0/admin/licence-reviews/{id}/commands/revoke', {
            ...options,
            body: command.body,
          });
          return requireData(data, 'licence review');
        }
        case 'recuse':
          // 204: the review leaves this admin's queue and can no longer be opened by them.
          await api.POST('/api/v0/admin/licence-reviews/{id}/commands/recuse', {
            ...options,
            body: command.body,
          });
          return null;
      }
    },
    onSuccess: (review) => {
      key.settle();
      if (review === null) {
        queryClient.removeQueries({ queryKey: licenceKeys.detail(id) });
      } else {
        if (review.images.front === false) {
          queryClient.removeQueries({ queryKey: [...licenceKeys.detail(id), 'image'] });
        }
        queryClient.setQueryData(licenceKeys.detail(id), review);
      }
      void queryClient.invalidateQueries({ queryKey: licenceKeys.lists() });
    },
    onError: (error) => {
      key.settle(error);
      if (isApiError(error) && (error.status === 409 || error.status === 403))
        void queryClient.invalidateQueries({ queryKey: licenceKeys.detail(id), exact: true });
    },
  });
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
