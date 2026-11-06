import { useNavigate } from 'react-router';
import { useLogout } from '../api/auth';

/** Revoke the session, clear local state, and go to the landing page. */
export function useSignOut(): () => void {
  const navigate = useNavigate();
  const logout = useLogout();
  return () => {
    logout.mutate(undefined, { onSettled: () => void navigate('/', { replace: true }) });
  };
}
