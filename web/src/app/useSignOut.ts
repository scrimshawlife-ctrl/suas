import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useLogout } from '../api/auth';
import { tokenStore } from '../api/token-store';

/**
 * Sign out: revoke the session (failure is fine: it may already be gone), then drop the token
 * with `signOut()`, which tells the route guards to go to "/" instead of /sign-in with a
 * `from` (that is for genuine expiry only). Also navigate to "/" for screens with no guard.
 */
export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useLogout();
  return async () => {
    try {
      await logout.mutateAsync();
    } catch {
      // Server unreachable or session already expired: still sign out here.
    }
    tokenStore.signOut();
    queryClient.clear();
    await navigate('/', { replace: true });
  };
}
