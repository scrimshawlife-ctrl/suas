import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { queryKeys } from './keys';
import type { County } from './types';

/** PUT /api/v0/veterans/me/profile: "First name and last initial", 1 to 40 characters. */
export function useUpdateProfile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (displayName: string) => {
      await api.PUT('/api/v0/veterans/me/profile', { body: { display_name: displayName } });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/**
 * PUT /api/v0/veterans/me/county. The open list and each request's county follow the person's
 * current county (src/coordination/open-requests.ts), so every request list and detail refreshes.
 */
export function useUpdateCounty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (county: County) => {
      await api.PUT('/api/v0/veterans/me/county', { body: { county } });
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.me }),
        queryClient.invalidateQueries({ queryKey: queryKeys.serviceRequests.all }),
      ]),
  });
}
