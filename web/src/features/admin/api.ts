import { queryOptions, useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { resourceKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import type { Schemas } from '../../api/types';

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
