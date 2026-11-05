import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router';
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
import { LoadingScreen } from './status-screens';

/** Lazy route: the screen module's default export becomes the route component. */
function page(load: () => Promise<{ default: ComponentType }>): Pick<RouteObject, 'lazy'> {
  return { lazy: async () => ({ Component: (await load()).default }) };
}

/**
 * Every route, with its guard chain. Guards nest in this order:
 * RequireSignedIn, RequireProfile, RequireVerified (requester routes only), RequireAdmin.
 *
 * Each screen is a file `features/<area>/<Screen>Page.tsx` with a default export. A screen
 * owner replaces that file and never edits this table.
 */
export const routes: RouteObject[] = [
  {
    errorElement: <RouteErrorPage />,
    HydrateFallback: LoadingScreen,
    children: [
      {
        // Public header. /welcome and /verify are signed in but still onboarding.
        element: <PublicLayout />,
        children: [
          { path: paths.landing, ...page(() => import('../features/public/LandingPage')) },
          { path: paths.signIn, ...page(() => import('../features/public/SignInPage')) },
          { path: paths.signInCode, ...page(() => import('../features/public/CodePage')) },
          {
            element: <RequireSignedIn />,
            children: [
              { path: paths.welcome, ...page(() => import('../features/public/WelcomePage')) },
              {
                element: <RequireProfile />,
                children: [
                  { path: paths.verify, ...page(() => import('../features/request/VerifyPage')) },
                ],
              },
            ],
          },
          { path: '*', ...page(() => import('./NotFoundPage')) },
        ],
      },
      {
        // /crisis is public: signed out and unverified people can open it.
        element: <AutoLayout />,
        children: [{ path: paths.crisis, ...page(() => import('../features/public/CrisisPage')) }],
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
                ...page(() => import('../features/support/NotificationsPage')),
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
                  { path: paths.home, ...page(() => import('../features/support/HomePage')) },
                  {
                    element: <RequireVerified />,
                    children: [
                      {
                        path: paths.request,
                        ...page(() => import('../features/request/RequestPage')),
                      },
                      {
                        path: '/requests/:id',
                        ...page(() => import('../features/request/RequestDetailPage')),
                      },
                      {
                        path: '/resources/:category',
                        ...page(() => import('../features/support/ResourcesPage')),
                      },
                      {
                        path: paths.checkIn,
                        ...page(() => import('../features/support/CheckInPage')),
                      },
                      {
                        path: paths.consents,
                        ...page(() => import('../features/support/ConsentsPage')),
                      },
                      {
                        path: paths.trustedContacts,
                        ...page(() => import('../features/support/TrustedContactsPage')),
                      },
                    ],
                  },
                ],
              },
              {
                // Serve mode. Anyone signed in with a profile can help; no scan.
                element: <ServeLayout />,
                children: [
                  { path: paths.serve, ...page(() => import('../features/serve/ServePage')) },
                  {
                    path: '/serve/requests/:id',
                    ...page(() => import('../features/serve/CasePage')),
                  },
                ],
              },
              {
                // Chat follows the last chosen mode: requester and accepter share the screen.
                element: <ModeLayout />,
                children: [
                  { path: paths.chat, ...page(() => import('../features/chat/ChatPage')) },
                  {
                    path: '/chat/:serviceRequestId',
                    ...page(() => import('../features/chat/ChatPage')),
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
                        ...page(() => import('../features/admin/AdminMfaPage')),
                      },
                      {
                        element: <RequireMfa />,
                        children: [
                          {
                            path: paths.admin,
                            ...page(() => import('../features/admin/AdminOverviewPage')),
                          },
                          {
                            path: paths.adminDrafts,
                            ...page(() => import('../features/admin/AdminDraftsPage')),
                          },
                          {
                            path: '/admin/drafts/:id',
                            ...page(() => import('../features/admin/AdminDraftPage')),
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
                { path: paths.devComponents, ...page(() => import('../dev/ComponentGallery')) },
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
