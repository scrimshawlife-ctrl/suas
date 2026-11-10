import { useMutation, useQuery } from '@tanstack/react-query';
import { meQueryOptions } from '../../api/me';
import { ApiError } from '../../api/errors';
import { useSessionToken } from '../../api/token-store';

const POLL_MS = 4000;

/**
 * The person's verification standing, read from GET /veterans/me (the old status route is
 * retired by suas-specs #72 R9.1, proposal). Polls gently while a check is PENDING.
 */
export function useIdVerification() {
  const token = useSessionToken();
  return useQuery({
    ...meQueryOptions(),
    enabled: token !== null,
    select: (me) => me.id_verification,
    refetchInterval: (q) => (q.state.data?.id_verification.status === 'PENDING' ? POLL_MS : false),
  });
}

/**
 * Placeholder until the Verify page collects the VA confirmation fields: the old start
 * route is retired, so starting reports verification as unavailable.
 */
export function useStartIdVerification() {
  return useMutation({
    mutationFn: () =>
      Promise.reject(
        new ApiError(
          503,
          'ID_VERIFICATION_UNAVAILABLE',
          'Veteran confirmation is not ready here yet.',
        ),
      ),
  });
}
