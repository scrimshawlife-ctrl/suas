import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { queryKeys } from '../../api/keys';
import { meQueryOptions } from '../../api/me';
import { requireData } from '../../api/require-data';
import { useSessionToken } from '../../api/token-store';
import type { Me } from '../../api/types';
import type { VaConfirmBody } from './verify-form';

/** The person's VA confirmation standing, read from GET /veterans/me (suas-specs #72 R9.1). */
export function useIdVerification() {
  const token = useSessionToken();
  return useQuery({
    ...meQueryOptions(),
    enabled: token !== null,
    select: (me) => me.id_verification,
  });
}

/**
 * POST /veterans/me/verification/va/confirm. One Idempotency-Key per distinct body: a double
 * submit replays the same attempt, a corrected body is a new one. After UNAVAILABLE or
 * VERIFIED the key is dropped, so "try again" really asks VA again.
 */
export function useConfirmVeteranStatus() {
  const queryClient = useQueryClient();
  const last = useRef<{ body: string; key: string } | null>(null);
  return useMutation({
    // Gone from the mutation cache as soon as the page resets it, so the body is not kept.
    gcTime: 0,
    mutationFn: async (body: VaConfirmBody) => {
      const fingerprint = JSON.stringify(body);
      if (last.current?.body !== fingerprint) {
        last.current = { body: fingerprint, key: crypto.randomUUID() };
      }
      const { data } = await api.POST('/api/v0/veterans/me/verification/va/confirm', {
        body,
        params: { header: { 'Idempotency-Key': last.current.key } },
      });
      return requireData(data, 'confirmation result');
    },
    onSuccess: (result) => {
      if (result.status !== 'NOT_CONFIRMED') last.current = null;
      // The answer is the new standing; the request guard reads it on Continue.
      queryClient.setQueryData<Me>(queryKeys.me, (me) =>
        me === undefined
          ? me
          : { ...me, id_verification: { method: 'VA_VETERAN_STATUS', ...result } },
      );
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}
