import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { ApiError } from './errors';
import { queryKeys } from './keys';
import { tokenStore } from './token-store';

/** Step 1: email a one-time code. The server answers 202 whether or not the email is enrolled. */
export function useStartChallenge() {
  return useMutation({
    mutationFn: async (destination: string) => {
      await api.POST('/api/v0/auth/challenges', { body: { destination, method: 'EMAIL_OTP' } });
    },
  });
}

/** Step 2: trade the code for a session. Stores the token and refreshes `me`. */
export function useVerifyChallenge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { destination: string; code: string }) => {
      const { data } = await api.POST('/api/v0/auth/challenges/commands/verify', { body: input });
      if (data === undefined)
        throw new ApiError(502, 'EMPTY_RESPONSE', 'The server sent no session.');
      return data;
    },
    onSuccess: async (session) => {
      tokenStore.setToken(session.session_credential, { mfaElevated: session.mfa_elevated });
      await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** Revokes the session on the server, then always clears it locally, even if the call fails. */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      await api.POST('/api/v0/auth/sessions/commands/logout');
    },
    onSettled: () => {
      tokenStore.clear();
      queryClient.clear();
    },
  });
}
