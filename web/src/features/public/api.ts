import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { hasApiCode } from '../../api/errors';
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

/** Writes a settled answer into the cached `me`, so the request guard reads it on Continue. */
function useSetStanding() {
  const queryClient = useQueryClient();
  return (standing: Me['id_verification']) =>
    queryClient.setQueryData<Me>(queryKeys.me, (me) =>
      me === undefined ? me : { ...me, id_verification: standing },
    );
}

/**
 * POST /veterans/me/verification/va/confirm. One Idempotency-Key per distinct body: a double
 * submit replays the same attempt, a corrected body is a new one. After UNAVAILABLE or
 * VERIFIED the key is dropped, so "try again" really asks VA again. A 409 IDEMPOTENCY_CONFLICT
 * (the server's key changed since the first send) also drops it, so the next send is new.
 */
export function useConfirmVeteranStatus() {
  const queryClient = useQueryClient();
  const setStanding = useSetStanding();
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
      setStanding({ method: 'VA_VETERAN_STATUS', ...result });
    },
    onError: (error) => {
      if (hasApiCode(error, 'IDEMPOTENCY_CONFLICT')) last.current = null;
    },
    onSettled: () => {
      // A VA answer decides whether the R10.1 licence path is offered.
      void queryClient.invalidateQueries({ queryKey: queryKeys.licence });
      return queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/**
 * POST /veterans/me/verification/commands/self-attest: the D-016 fallback, a SELF_ATTESTATION
 * VERIFIED standing. One key per page visit, so a double click records it once; a 409
 * IDEMPOTENCY_CONFLICT drops the key so pressing again sends a new command.
 */
export function useSelfAttest() {
  const queryClient = useQueryClient();
  const setStanding = useSetStanding();
  const key = useRef<string | null>(null);
  return useMutation({
    mutationFn: async () => {
      key.current ??= crypto.randomUUID();
      const { data } = await api.POST('/api/v0/veterans/me/verification/commands/self-attest', {
        params: { header: { 'Idempotency-Key': key.current } },
      });
      return requireData(data, 'self-attestation result');
    },
    onSuccess: (standing) => setStanding(standing),
    onError: (error) => {
      if (hasApiCode(error, 'IDEMPOTENCY_CONFLICT')) key.current = null;
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}
