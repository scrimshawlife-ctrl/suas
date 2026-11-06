import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/me';
import { useMfaElevated, useSessionToken } from '../api/token-store';
import { paths } from './paths';
import { LoadFailedScreen, LoadingScreen } from './status-screens';

/**
 * Route guards, applied by nesting in router.tsx in this order:
 * signed in, profile complete, verified (requester routes only), admin.
 */

/** 1. A session token exists. Otherwise sign in, and come back to where the person was going. */
export function RequireSignedIn() {
  const token = useSessionToken();
  const location = useLocation();
  if (token === null) {
    return (
      <Navigate
        to={paths.signIn}
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }
  return <Outlet />;
}

/** 2. `display_name` and `county` are both set. Otherwise onboarding at /welcome. */
export function RequireProfile() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) return <LoadFailedScreen onRetry={() => void me.refetch()} />;
  if (!me.data.display_name || !me.data.county) return <Navigate to={paths.welcome} replace />;
  return <Outlet />;
}

/** 3. The ID scan is VERIFIED. Requester routes only: helping and Serve never need it. */
export function RequireVerified() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) return <LoadFailedScreen onRetry={() => void me.refetch()} />;
  if (me.data.id_verification.status !== 'VERIFIED') return <Navigate to={paths.verify} replace />;
  return <Outlet />;
}

/** 4a. `me.is_admin`. Anyone else goes home. */
export function RequireAdmin() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) return <LoadFailedScreen onRetry={() => void me.refetch()} />;
  if (!me.data.is_admin) return <Navigate to={paths.home} replace />;
  return <Outlet />;
}

/** 4b. Admin session has passed MFA step-up. Otherwise the step-up screen. */
export function RequireMfa() {
  const elevated = useMfaElevated();
  if (!elevated) return <Navigate to={paths.adminMfa} replace />;
  return <Outlet />;
}
