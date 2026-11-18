import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useCommandKey } from '../../api/idempotency';
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
 * POST /veterans/me/verification/va/confirm with one Idempotency-Key per distinct body
 * (`useCommandKey`): a double submit or a retry while the first may still be with VA replays
 * that attempt, a corrected body is a new one. NOT_CONFIRMED keeps the key, so resending the
 * same details replays VA's answer (W3); after UNAVAILABLE or VERIFIED "try again" asks VA anew.
 */
export function useConfirmVeteranStatus() {
  const queryClient = useQueryClient();
  const setStanding = useSetStanding();
  const key = useCommandKey();
  return useMutation({
    // Gone from the mutation cache as soon as the page resets it, so the body is not kept.
    gcTime: 0,
    mutationFn: async (body: VaConfirmBody) => {
      const { data } = await api.POST('/api/v0/veterans/me/verification/va/confirm', {
        body,
        params: { header: key.headers(body) },
      });
      return requireData(data, 'confirmation result');
    },
    onSuccess: (result, body) => {
      if (result.status !== 'NOT_CONFIRMED') key.settle(body);
      setStanding({ method: 'VA_VETERAN_STATUS', ...result });
    },
    onError: (error, body) => key.settle(body, error),
    onSettled: () => {
      // A VA answer decides whether the R10.1 licence path is offered.
      void queryClient.invalidateQueries({ queryKey: queryKeys.licence });
      return queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/**
 * POST /veterans/me/verification/commands/self-attest: the D-016 fallback, a SELF_ATTESTATION
 * VERIFIED standing. One key per press (`useCommandKey`), so a double click or a retry after a
 * 409 IDEMPOTENCY_CONFLICT records it once.
 */
export function useSelfAttest() {
  const queryClient = useQueryClient();
  const setStanding = useSetStanding();
  const key = useCommandKey();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST('/api/v0/veterans/me/verification/commands/self-attest', {
        params: { header: key.headers() },
      });
      return requireData(data, 'self-attestation result');
    },
    onSuccess: (standing) => {
      key.settle(undefined);
      setStanding(standing);
    },
    onError: (error) => key.settle(undefined, error),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.me }),
  });
}
