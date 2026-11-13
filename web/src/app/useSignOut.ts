import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useLogout } from '../api/auth';
import { tokenStore } from '../api/token-store';
import { openDraft } from '../features/request/open-draft';

/**
 * Sign out: revoke the session (failure is fine: it may already be gone), then drop the token
 * with `signOut()`, which tells the route guards to go to "/" instead of /sign-in with a
 * `from` (that is for genuine expiry only). Also navigate to "/" for screens with no guard.
 * The open draft's id goes too, so the next person in this tab does not resume it (R12.1).
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
    openDraft.clear();
    queryClient.clear();
    await navigate('/', { replace: true });
  };
}
