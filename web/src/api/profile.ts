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

/** PUT /api/v0/veterans/me/county. */
export function useUpdateCounty() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (county: County) => {
      await api.PUT('/api/v0/veterans/me/county', { body: { county } });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}
