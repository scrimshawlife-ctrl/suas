import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useCommandKey } from '../../api/idempotency';
import { queryKeys, resourceKeys } from '../../api/keys';
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
