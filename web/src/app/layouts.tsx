import { useEffect, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router';
import { useMe } from '../api/me';
import { useMfaElevated, useSessionToken } from '../api/token-store';
import { AdminLayout, type AdminNavItem } from '../components/AdminLayout';
import { BottomTabBar } from '../components/BottomTabBar';
import { CrisisStrip } from '../components/CrisisStrip';
import { SkipLink } from '../components/SkipLink';
import { Footer } from '../components/Footer';
import { ModeSwitch, type Mode } from '../components/ModeSwitch';
import { PublicHeader } from '../components/PublicHeader';
import { ServeHeader } from '../components/ServeHeader';
import { VeteranHeader } from '../components/VeteranHeader';
import { useBuildInfo } from '../features/admin/api';
import { adminScopeLine } from '../features/admin/scope';
import { useChatUnreadCount } from '../features/chat/unread';
import { setMode, useMode } from './mode-store';
import { navCurrent, type NavCurrent } from './nav-current';
import { paths } from './paths';
import { useSignOut } from './useSignOut';

/**
 * Chrome per area. The crisis strip is first on every veteran screen, signed in or not.
 *  - PublicLayout: signed-out and onboarding screens (public header).
 *  - SupportLayout: Need support mode (light veteran header); remembers the mode.
 *  - ServeLayout: Serve mode (Harbor header); remembers the mode.
 *  - ModeLayout: screens shared by both modes (chat, notifications); follows the last mode.
 *  - AutoLayout: /crisis, which is open to signed-out people too.
 *  - AdminShell: Harbor sidebar.
 */

function PageFrame({
  header,
  mode,
  current,
  chatUnread = 0,
  children,
}: {
  header: ReactNode;
  mode?: Mode;
  current?: NavCurrent;
  chatUnread?: number;
  children: ReactNode;
}) {
  const signedInChrome = mode !== undefined;
  return (
    <div
      className={
        // Phones: leave room under the footer for the fixed tab bar (64 px plus its bottom
        // padding, which grows with the device safe-area inset).
        signedInChrome
          ? 'flex min-h-screen flex-col max-sm:pb-[calc(4.25rem+max(1.125rem,env(safe-area-inset-bottom)))]'
          : 'flex min-h-screen flex-col'
      }
    >
      <SkipLink />
      <CrisisStrip />
      {header}
      <main id="main" className="flex-1">
        {signedInChrome ? (
          <div className="mx-auto max-w-[1200px] px-6 pt-4 sm:hidden max-sm:px-4">
            <ModeSwitch mode={mode} fullWidth onSelect={setMode} />
          </div>
        ) : null}
        {children}
      </main>
      <Footer />
      {signedInChrome ? (
        <BottomTabBar mode={mode} current={current ?? 'none'} chatUnread={chatUnread} />
      ) : null}
    </div>
  );
}

export function PublicLayout() {
  const token = useSessionToken();
  const { pathname } = useLocation();
  const signOut = useSignOut();
  const landing = pathname === paths.landing;
  return (
    <div className="flex min-h-screen flex-col">
      <SkipLink />
      <CrisisStrip />
      <PublicHeader
        onSignOut={token ? signOut : undefined}
        hideSignIn={pathname.startsWith(paths.signIn)}
      />
      <main id="main" className="flex-1">
        <Outlet />
      </main>
      <Footer showVeteransCrisisLine={landing} />
    </div>
  );
}

function SignedInChrome({ mode }: { mode: Mode }) {
  const me = useMe();
  const signOut = useSignOut();
  const current = navCurrent(useLocation().pathname);
  const chatUnread = useChatUnreadCount();
  const header =
    mode === 'serve' ? (
      <ServeHeader
        current={current}
        displayName={me.data?.display_name ?? null}
        onSignOut={signOut}
        onModeSelect={setMode}
        chatUnread={chatUnread}
      />
    ) : (
      <VeteranHeader
        current={current}
        displayName={me.data?.display_name ?? null}
        onSignOut={signOut}
        onModeSelect={setMode}
        chatUnread={chatUnread}
      />
    );
  return (
    <PageFrame header={header} mode={mode} current={current} chatUnread={chatUnread}>
      <Outlet />
    </PageFrame>
  );
}

export function SupportLayout() {
  useEffect(() => setMode('support'), []);
  return <SignedInChrome mode="support" />;
}

export function ServeLayout() {
  useEffect(() => setMode('serve'), []);
  return <SignedInChrome mode="serve" />;
}

export function ModeLayout() {
  return <SignedInChrome mode={useMode()} />;
}

export function AutoLayout() {
  const token = useSessionToken();
  return token === null ? <PublicLayout /> : <ModeLayout />;
}

const adminNav: readonly AdminNavItem[] = [
  { label: 'Overview', to: paths.admin },
  { label: 'Resource drafts', to: paths.adminDrafts },
  { label: 'Consent templates', to: paths.adminConsentTemplates },
  { label: 'Licence reviews', to: paths.adminLicenceReviews },
  { label: 'Access', to: paths.admin, soon: true },
  { label: 'Published artifacts', to: paths.admin, soon: true },
  { label: 'Platform operations', to: paths.admin, soon: true },
  { label: 'Audit explorer', to: paths.admin, soon: true },
];

export function AdminShell() {
  const signOut = useSignOut();
  const { pathname } = useLocation();
  const info = useBuildInfo(useMfaElevated());
  const scope = adminScopeLine(info.data?.environment);
  const nav = adminNav.map((item) => ({
    ...item,
    current:
      !item.soon &&
      (item.to === paths.admin ? pathname === paths.admin : pathname.startsWith(item.to)),
  }));
  return (
    <AdminLayout nav={nav} onSignOut={signOut} scope={scope}>
      <Outlet />
    </AdminLayout>
  );
}

/** Bare frame for the dev gallery: no crisis chrome, so the page shows only components. */
export function DevLayout() {
  return <Outlet />;
}
