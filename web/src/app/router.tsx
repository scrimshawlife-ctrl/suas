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
import { HydrateFallbackScreen } from './status-screens';

/**
 * One wrapper component per loaded screen and title. Routes that load the same screen with the
 * same title (`/chat` and `/chat/:id`) must share a component type, otherwise React remounts the
 * screen when the route changes and loses its state, scroll position and focus.
 */
const wrappers = new WeakMap<ComponentType, Map<string, ComponentType>>();

function wrapScreen(Screen: ComponentType, fullTitle: string): ComponentType {
  let byTitle = wrappers.get(Screen);
  if (byTitle === undefined) {
    byTitle = new Map();
    wrappers.set(Screen, byTitle);
  }
  let Wrapped = byTitle.get(fullTitle);
  if (Wrapped === undefined) {
    Wrapped = function RouteScreen() {
      return (
        <>
          <title>{fullTitle}</title>
          <Screen />
        </>
      );
    };
    byTitle.set(fullTitle, Wrapped);
  }
  return Wrapped;
}

/**
 * Lazy route: the screen module's default export becomes the route component. `title` is the
 * document title for every state of the route (loading, error, loaded); a screen that renders
 * its own more specific `<title>` takes precedence once it is mounted. `suffix` is the site
 * part of the title and must match the one the screens use (the admin pages say "SUAS Admin").
 */
function page(
  title: string,
  load: () => Promise<{ default: ComponentType }>,
  suffix = 'SUAS',
): Pick<RouteObject, 'lazy'> {
  return {
    lazy: async () => ({
      Component: wrapScreen((await load()).default, `${title} · ${suffix}`),
    }),
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
    HydrateFallback: HydrateFallbackScreen,
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
                element: <RequireProfile framed />,
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
                        path: paths.requests,
                        ...page('Your requests', () => import('../features/request/RequestsPage')),
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
                              'SUAS Admin',
                            ),
                          },
                          {
                            path: paths.adminDrafts,
                            ...page(
                              'Resource drafts',
                              () => import('../features/admin/AdminDraftsPage'),
                              'SUAS Admin',
                            ),
                          },
                          {
                            path: '/admin/drafts/:id',
                            ...page(
                              'Resource draft',
                              () => import('../features/admin/AdminDraftPage'),
                              'SUAS Admin',
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
