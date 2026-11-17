import {
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '../../api/client';
import { isApiError } from '../../api/errors';
import { useCommandKey } from '../../api/idempotency';
import { queryKeys, resourceKeys } from '../../api/keys';
import { cursorPages } from '../../api/queries';
import { requireData } from '../../api/require-data';
import type { Schemas } from '../../api/types';

export type AdapterCatalogEntry = Schemas['AdapterCatalogEntry'];
export type BuildInfo = Schemas['BuildInfo'];
export type ConsentTemplateVersion = Schemas['ConsentTemplateVersion'];

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
    }),
  );
}

const PAGE_SIZE = 20;

export type AdminLicenceReview = Schemas['AdminLicenceReview'];
export type LicenceImageSide = 'front' | 'back' | 'selfie';

const licenceKeys = queryKeys.adminLicenceReviews;

/**
 * Open licence reviews, oldest first (suas-specs #73 R10.1, released in 0.10.0, L5.1). The server leaves
 * out the admin's own reviews, recusals and disputes of reviews they decided; rows carry no names.
 */
export function useLicenceReviews() {
  return useInfiniteQuery(
    cursorPages({
      queryKey: licenceKeys.lists(),
      fetchPage: async (page) => {
        const { data } = await api.GET('/api/v0/admin/licence-reviews', {
          params: { query: { limit: PAGE_SIZE, ...page } },
        });
        return requireData(data, 'licence reviews');
      },
    }),
  );
}

export function useAdminLicenceReview(id: string, enabled = true) {
  return useQuery({
    queryKey: licenceKeys.detail(id),
    enabled,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/admin/licence-reviews/{id}', {
        params: { path: { id } },
      });
      return requireData(data, 'licence review');
    },
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

/** Every consent template version, newest version of each key first (R9.3). */
export function useConsentTemplates() {
  return useQuery({
    queryKey: queryKeys.adminConsentTemplates.list(),
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/admin/consent-templates');
      return requireData(data, 'consent templates').templates;
    },
  });
}

/** A new DRAFT version of a template key; the server numbers it. */
export function useCreateConsentTemplate() {
  const queryClient = useQueryClient();
  const key = useCommandKey();
  return useMutation({
    mutationFn: async (body: { template_key: string; body: string }) => {
      const { data } = await api.POST('/api/v0/admin/consent-templates', {
        body,
        headers: key.headers(),
      });
      return requireData(data, 'consent template');
    },
    onSuccess: () => {
      key.settle();
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminConsentTemplates.all });
    },
    onError: key.settle,
  });
}

/** Publish a DRAFT version; the key's earlier published version is superseded. */
export function usePublishConsentTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (version: string) => {
      const { data } = await api.POST(
        '/api/v0/admin/consent-templates/{version}/commands/publish',
        {
          params: { path: { version } },
        },
      );
      return requireData(data, 'published template');
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.adminConsentTemplates.all }),
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
