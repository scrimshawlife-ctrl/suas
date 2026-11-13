import { useMemo, type ReactNode } from 'react';
import { Navigate, Outlet, useLocation, useParams } from 'react-router';
import { useMe } from '../api/me';
import { useServiceRequest } from '../api/service-requests';
import { tokenStore, useMfaElevated, useSessionToken } from '../api/token-store';
import { paths } from './paths';
import { LoadFailedScreen, LoadingScreen, WithCrisisStrip } from './status-screens';

/** Where to come back to after an onboarding or step-up detour. */
function returnPath(location: { pathname: string; search: string }): string {
  return `${location.pathname}${location.search}`;
}

/**
 * A redirect that remembers where the person was going. Its `state` keeps one identity per
 * address: a new object on each render re-ran Navigate's effect, so a guard re-rendering while
 * a lazy target loaded navigated in a loop ("Maximum update depth exceeded").
 */
function RedirectWithReturn({ to }: { to: string }) {
  const from = returnPath(useLocation());
  const state = useMemo(() => ({ from }), [from]);
  return <Navigate to={to} replace state={state} />;
}

/**
 * Route guards, applied by nesting in router.tsx in this order:
 * signed in, profile complete, verified (requester routes only), admin.
 */

/** 1. A session token exists. Otherwise sign in, and come back to where the person was going. */
export function RequireSignedIn() {
  const token = useSessionToken();
  if (token === null) {
    // Signing out on purpose ends on the landing page, not on a sign-in prompt with a return path.
    if (tokenStore.isSignedOut()) return <Navigate to={paths.landing} replace />;
    return <RedirectWithReturn to={paths.signIn} />;
  }
  return <Outlet />;
}

/**
 * 2. `display_name` and `county` are both set. Otherwise onboarding at /welcome. Its loading
 * and failed screens render outside any layout, so they carry the crisis strip, unless
 * `framed` says a layout above already shows it (/verify sits in the public layout).
 */
export function RequireProfile({ framed = false }: { framed?: boolean }) {
  const me = useMe();
  const standalone = (screen: ReactNode) =>
    framed ? screen : <WithCrisisStrip>{screen}</WithCrisisStrip>;
  if (me.isPending) return standalone(<LoadingScreen />);
  if (me.isError) return standalone(<LoadFailedScreen onRetry={() => void me.refetch()} />);
  if (!me.data.display_name || !me.data.county) {
    return <RedirectWithReturn to={paths.welcome} />;
  }
  return <Outlet />;
}

/** 3. The VA confirmation is VERIFIED. Requester routes only: helping and Serve never need it. */
export function RequireVerified() {
  const me = useMe();
  if (me.isPending) return <LoadingScreen />;
  if (me.isError) return <LoadFailedScreen onRetry={() => void me.refetch()} />;
  if (me.data.id_verification.status !== 'VERIFIED') {
    // Right after the ID check, `me` is being re-read; wait for it instead of bouncing back.
    if (me.isFetching) return <LoadingScreen />;
    return <RedirectWithReturn to={paths.verify} />;
  }
  return <Outlet />;
}

/**
 * 3b. /requests/:id: RequireVerified, except that the helper who accepted the request (helping
 * never needs the scan) goes to their case page. Only the requester or accepter can read it.
 */
export function RequireVerifiedOrAccepter() {
  const me = useMe();
  const { id } = useParams();
  const unverified = me.data !== undefined && me.data.id_verification.status !== 'VERIFIED';
  const request = useServiceRequest(unverified ? id : undefined);
  if (!unverified) return <RequireVerified />;
  if (request.isPending) return <LoadingScreen />;
  if (request.data?.viewer_role === 'ACCEPTER') {
    return <Navigate to={paths.case(request.data.service_request_id)} replace />;
  }
  return <RequireVerified />;
}

/**
 * 4a. `me.is_admin`. Anyone else goes home. The admin routes sit outside every layout, so
 * its loading and failed screens carry the crisis strip themselves.
 */
export function RequireAdmin() {
  const me = useMe();
  if (me.isPending) {
    return (
      <WithCrisisStrip>
        <LoadingScreen />
      </WithCrisisStrip>
    );
  }
  if (me.isError) {
    return (
      <WithCrisisStrip>
        <LoadFailedScreen onRetry={() => void me.refetch()} />
      </WithCrisisStrip>
    );
  }
  if (!me.data.is_admin) return <Navigate to={paths.home} replace />;
  return <Outlet />;
}

/** 4b. Admin session has passed MFA step-up. Otherwise the step-up screen. */
export function RequireMfa() {
  const elevated = useMfaElevated();
  if (!elevated) return <RedirectWithReturn to={paths.adminMfa} />;
  return <Outlet />;
}
