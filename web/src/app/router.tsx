import type { ComponentType } from 'react';
import { createBrowserRouter, Outlet, type RouteObject } from 'react-router';
import {
  RequireAdmin,
  RequireMfa,
  RequireProfile,
  RequireSignedIn,
  RequireVerified,
} from './guards';
import {
  AdminShell,
  AutoLayout,
  DevLayout,
  ModeLayout,
  PublicLayout,
  ServeLayout,
  SupportLayout,
} from './layouts';
import { paths } from './paths';
import RouteErrorPage from './RouteErrorPage';
import { FocusRescue, RouteFocus } from './RouteFocus';
import { LoadingScreen } from './status-screens';

/**
 * Lazy route: the screen module's default export becomes the route component. `title` is the
 * document title for every state of the route (loading, error, loaded); a screen that renders
 * its own more specific `<title>` takes precedence once it is mounted.
 */
function page(
  title: string,
  load: () => Promise<{ default: ComponentType }>,
): Pick<RouteObject, 'lazy'> {
  return {
    lazy: async () => {
      const Screen = (await load()).default;
      return {
        Component: () => (
          <>
            <title>{`${title} · SUAS`}</title>
            <Screen />
          </>
        ),
      };
    },
  };
}

/**
 * Every route, with its guard chain. Guards nest in this order:
 * RequireSignedIn, RequireProfile, RequireVerified (requester routes only), RequireAdmin.
 *
 * Each screen is a file `features/<area>/<Screen>Page.tsx` with a default export. A screen
 * owner replaces that file and never edits this table.
 */
function RootRoute() {
  return (
    <>
      <RouteFocus />
      <FocusRescue />
      <Outlet />
    </>
  );
}

export const routes: RouteObject[] = [
  {
    element: <RootRoute />,
    errorElement: <RouteErrorPage />,
    HydrateFallback: LoadingScreen,
    children: [
      {
        // Public header. /welcome and /verify are signed in but still onboarding.
        element: <PublicLayout />,
        children: [
          {
            path: paths.landing,
            ...page('Veterans helping veterans', () => import('../features/public/LandingPage')),
          },
          { path: paths.signIn, ...page('Sign in', () => import('../features/public/SignInPage')) },
          {
            path: paths.signInCode,
            ...page('Enter the code', () => import('../features/public/CodePage')),
          },
          {
            element: <RequireSignedIn />,
            children: [
              {
                path: paths.welcome,
                ...page('Welcome', () => import('../features/public/WelcomePage')),
              },
              {
                element: <RequireProfile />,
                children: [
                  {
                    path: paths.verify,
                    ...page('Confirm you served', () => import('../features/request/VerifyPage')),
                  },
                ],
              },
            ],
          },
          { path: '*', ...page('Page not found', () => import('./NotFoundPage')) },
        ],
      },
      {
        // /crisis is public: signed out and unverified people can open it.
        element: <AutoLayout />,
        children: [
          {
            path: paths.crisis,
            ...page('Immediate resources', () => import('../features/public/CrisisPage')),
          },
        ],
      },
      {
        element: <RequireSignedIn />,
        children: [
          {
            // Signed in only; no profile needed to read notifications.
            element: <ModeLayout />,
            children: [
              {
                path: paths.notifications,
                ...page('Notifications', () => import('../features/support/NotificationsPage')),
              },
            ],
          },
          {
            element: <RequireProfile />,
            children: [
              {
                // Need support mode. Home needs no scan; the rest are requester routes.
                element: <SupportLayout />,
                children: [
                  {
                    path: paths.home,
                    ...page('Home', () => import('../features/support/HomePage')),
                  },
                  {
                    element: <RequireVerified />,
                    children: [
                      {
                        path: paths.request,
                        ...page('Request help', () => import('../features/request/RequestPage')),
                      },
                      {
                        path: '/requests/:id',
                        ...page(
                          'Your request',
                          () => import('../features/request/RequestDetailPage'),
                        ),
                      },
                      {
                        path: '/resources/:category',
                        ...page('Resources', () => import('../features/support/ResourcesPage')),
                      },
                      {
                        path: paths.checkIn,
                        ...page('Check-In', () => import('../features/support/CheckInPage')),
                      },
                      {
                        path: paths.consents,
                        ...page('What you share', () => import('../features/support/ConsentsPage')),
                      },
                      {
                        path: paths.trustedContacts,
                        ...page(
                          'Trusted contacts',
                          () => import('../features/support/TrustedContactsPage'),
                        ),
                      },
                    ],
                  },
                ],
              },
              {
                // Serve mode. Anyone signed in with a profile can help; no scan.
                element: <ServeLayout />,
                children: [
                  {
                    path: paths.serve,
                    ...page('Serve', () => import('../features/serve/ServePage')),
                  },
                  {
                    path: '/serve/requests/:id',
                    ...page('Request details', () => import('../features/serve/CasePage')),
                  },
                ],
              },
              {
                // Chat follows the last chosen mode: requester and accepter share the screen.
                element: <ModeLayout />,
                children: [
                  { path: paths.chat, ...page('Chat', () => import('../features/chat/ChatPage')) },
                  {
                    path: '/chat/:serviceRequestId',
                    ...page('Chat', () => import('../features/chat/ChatPage')),
                  },
                ],
              },
              {
                element: <RequireAdmin />,
                children: [
                  {
                    element: <AdminShell />,
                    children: [
                      {
                        path: paths.adminMfa,
                        ...page(
                          'Confirm it is you',
                          () => import('../features/admin/AdminMfaPage'),
                        ),
                      },
                      {
                        element: <RequireMfa />,
                        children: [
                          {
                            path: paths.admin,
                            ...page(
                              'Overview',
                              () => import('../features/admin/AdminOverviewPage'),
                            ),
                          },
                          {
                            path: paths.adminDrafts,
                            ...page(
                              'Resource drafts',
                              () => import('../features/admin/AdminDraftsPage'),
                            ),
                          },
                          {
                            path: '/admin/drafts/:id',
                            ...page(
                              'Resource draft',
                              () => import('../features/admin/AdminDraftPage'),
                            ),
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      // Dev builds only: the component gallery used for design review.
      ...(import.meta.env.DEV
        ? [
            {
              element: <DevLayout />,
              children: [
                {
                  path: paths.devComponents,
                  ...page('Component gallery', () => import('../dev/ComponentGallery')),
                },
              ],
            },
          ]
        : []),
    ],
  },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
