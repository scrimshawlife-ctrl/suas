import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../../api/client';
import { queryKeys, resourceKeys } from '../../api/keys';
import { requireData } from '../../api/require-data';
import { useSessionToken } from '../../api/token-store';
import { useIdempotencyKey } from '../../api/idempotency';

const idVerificationKeys = resourceKeys('id-verification');
const POLL_MS = 4000;

/** GET /veterans/me/id-verification. Polls gently while the check is PENDING. */
export function useIdVerification() {
  const token = useSessionToken();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: idVerificationKeys.all,
    queryFn: async () => {
      const { data } = await api.GET('/api/v0/veterans/me/id-verification');
      return requireData(data, 'verification status');
    },
    enabled: token !== null,
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? POLL_MS : false),
  });
  const verified = query.data?.status === 'VERIFIED';
  // The route guards read `me`, so refresh it once the check passes.
  useEffect(() => {
    if (verified) void queryClient.invalidateQueries({ queryKey: queryKeys.me });
  }, [verified, queryClient]);
  return query;
}

/** POST /veterans/me/id-verification/commands/start. One key per user action. */
export function useStartIdVerification() {
  const queryClient = useQueryClient();
  const key = useIdempotencyKey();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.POST('/api/v0/veterans/me/id-verification/commands/start', {
        headers: key.headers(),
      });
      return requireData(data, 'verification status');
    },
    onSuccess: (data) => {
      key.renew();
      queryClient.setQueryData(idVerificationKeys.all, data);
      return queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
