import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { queryKeys } from '../api/keys';
import type { Me as MeResponse } from '../api/types';
import { tokenStore } from '../api/token-store';
import {
  RequireAdmin,
  RequireMfa,
  RequireProfile,
  RequireSignedIn,
  RequireVerified,
  RequireVerifiedOrAccepter,
} from './guards';

const client = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../api/client', () => ({ api: client }));

type VerificationStatus = MeResponse['id_verification']['status'];

function me(
  overrides: Partial<MeResponse> = {},
  status: VerificationStatus = 'VERIFIED',
): MeResponse {
  return {
    user_id: '11111111-1111-4111-8111-111111111111',
    status: 'ACTIVE',
    enrolled_channels: { email: true, phone: false },
    county: 'SANTA_CLARA',
    id_verification: { method: 'ID_SCAN_SELFIE', status, verified_at: null },
    open_case: null,
    active_qrf: null,
    categories: [],
    display_name: 'Marcus T.',
    is_admin: false,
    ...overrides,
  };
}

/** The guard chain exactly as router.tsx nests it, ending in a marker page. */
const routes: RouteObject[] = [
  { path: '/sign-in', element: <p>sign in page</p> },
  { path: '/welcome', element: <p>welcome page</p> },
  { path: '/verify', element: <p>verify page</p> },
  { path: '/home', element: <p>home page</p> },
  { path: '/admin/mfa', element: <p>mfa page</p> },
  {
    element: <RequireSignedIn />,
    children: [
      {
        element: <RequireProfile />,
        children: [
          { path: '/serve', element: <p>serve page</p> },
          { path: '/serve/requests/:id', element: <p>case page</p> },
          {
            element: <RequireVerifiedOrAccepter />,
            children: [{ path: '/requests/:id', element: <p>request detail page</p> }],
          },
          {
            element: <RequireVerified />,
            children: [{ path: '/request', element: <p>request page</p> }],
          },
          {
            element: <RequireAdmin />,
            children: [
              {
                element: <RequireMfa />,
                children: [{ path: '/admin', element: <p>admin page</p> }],
              },
            ],
          },
        ],
      },
    ],
  },
];

function visit(
  path: string,
  profile: MeResponse | null,
  token: string | null = 'tok',
  mfaElevated = false,
) {
  if (token) tokenStore.setToken(token, { mfaElevated });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (profile) queryClient.setQueryData(queryKeys.me, profile);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  tokenStore.clear();
  client.GET.mockReset();
});

describe('route guards', () => {
  it('sends a signed-out visitor to /sign-in', () => {
    const router = visit('/request', null, null);
    expect(screen.getByText('sign in page')).toBeInTheDocument();
    expect(router.state.location.state).toEqual({ from: '/request' });
  });

  it('sends an incomplete profile to /welcome (missing name or county)', () => {
    visit('/serve', me({ display_name: null }));
    expect(screen.getByText('welcome page')).toBeInTheDocument();
  });

  it('sends a missing county to /welcome', () => {
    visit('/serve', me({ county: null }));
    expect(screen.getByText('welcome page')).toBeInTheDocument();
  });

  it('sends an unverified requester to /verify but lets them into Serve', () => {
    visit('/request', me({}, 'NOT_STARTED'));
    expect(screen.getByText('verify page')).toBeInTheDocument();
  });

  it('remembers where the person was going on the /welcome and /verify detours', () => {
    const toWelcome = visit('/serve?tab=open', me({ display_name: null }));
    expect(toWelcome.state.location.state).toEqual({ from: '/serve?tab=open' });
    cleanup();
    const toVerify = visit('/request?category=FOOD', me({}, 'NOT_STARTED'));
    expect(toVerify.state.location.state).toEqual({ from: '/request?category=FOOD' });
  });

  it('does not require the scan for Serve', () => {
    visit('/serve', me({}, 'NOT_STARTED'));
    expect(screen.getByText('serve page')).toBeInTheDocument();
  });

  it('waits for the me re-read after the ID check instead of bouncing back to /verify', async () => {
    // Regression: Continue right after the ID check saw the stale NOT_STARTED and bounced.
    let answer: (value: { data: MeResponse }) => void = () => undefined;
    client.GET.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    tokenStore.setToken('tok');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.me, me({}, 'NOT_STARTED'));
    await queryClient.invalidateQueries({ queryKey: queryKeys.me });
    const router = createMemoryRouter(routes, { initialEntries: ['/request'] });
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    answer({ data: me() });
    expect(await screen.findByText('request page')).toBeInTheDocument();
  });

  it('lets a verified requester in', () => {
    visit('/request', me());
    expect(screen.getByText('request page')).toBeInTheDocument();
  });

  it('sends a non-admin away from /admin', () => {
    visit('/admin', me());
    expect(screen.getByText('home page')).toBeInTheDocument();
  });

  it('sends an admin without MFA to the step-up screen', () => {
    visit('/admin', me({ is_admin: true }));
    expect(screen.getByText('mfa page')).toBeInTheDocument();
  });

  it('lets an MFA-elevated admin in', () => {
    visit('/admin', me({ is_admin: true }), 'tok', true);
    expect(screen.getByText('admin page')).toBeInTheDocument();
  });
});

describe('RequireVerifiedOrAccepter (/requests/:id)', () => {
  const ID = '22222222-2222-4222-8222-222222222222';

  it('sends the unverified helper who accepted to their case page', async () => {
    client.GET.mockResolvedValue({ data: { service_request_id: ID, viewer_role: 'ACCEPTER' } });
    visit(`/requests/${ID}`, me({}, 'NOT_STARTED'));
    expect(await screen.findByText('case page')).toBeInTheDocument();
  });

  it('still sends any other unverified person to /verify', async () => {
    client.GET.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Resource not found.'));
    const router = visit(`/requests/${ID}`, me({}, 'NOT_STARTED'));
    expect(await screen.findByText('verify page')).toBeInTheDocument();
    expect(router.state.location.state).toEqual({ from: `/requests/${ID}` });
  });

  it('lets a verified person in without asking who they are', () => {
    visit(`/requests/${ID}`, me());
    expect(screen.getByText('request detail page')).toBeInTheDocument();
    expect(client.GET).not.toHaveBeenCalled();
  });
});

describe('RequireAdmin loading and failed screens', () => {
  /** RequireAdmin alone, so its own screens show rather than RequireProfile's. */
  function visitAdmin() {
    tokenStore.setToken('tok');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [{ element: <RequireAdmin />, children: [{ path: '/admin', element: <p>admin page</p> }] }],
      { initialEntries: ['/admin'] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  const expectCrisisStrip = () => {
    expect(screen.getByRole('complementary', { name: 'Crisis support' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Call 911' })).toHaveAttribute('href', 'tel:911');
    expect(screen.getByRole('link', { name: 'Call 988' })).toHaveAttribute('href', 'tel:988');
  };

  it('shows the crisis strip while the account loads', () => {
    client.GET.mockReturnValue(new Promise(() => undefined));
    visitAdmin();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expectCrisisStrip();
  });

  it('shows the crisis strip when the account fails to load', async () => {
    // A 4xx is not retried (meQueryOptions), so the failed screen shows at once.
    client.GET.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Not found.'));
    visitAdmin();
    expect(
      await screen.findByRole('heading', { name: 'We could not load your account.' }),
    ).toBeInTheDocument();
    expectCrisisStrip();
  });
});

describe('redirects while the target route is still loading', () => {
  // Regression: an unverified person on /requests/:id re-rendered the guard while the lazy
  // /verify chunk loaded, and each render navigated again (CI, request/07-deep-links).
  it('sends an unverified person from a request link to /verify once, with no update loop', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    client.GET.mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'Resource not found.'));
    tokenStore.setToken('tok');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(queryKeys.me, me({}, 'NOT_STARTED'));
    let loaded: () => void = () => undefined;
    const verifyChunk = new Promise<void>((resolve) => (loaded = resolve));
    const router = createMemoryRouter(
      [
        {
          path: '/verify',
          lazy: async () => {
            await verifyChunk;
            return { element: <p>verify page</p> };
          },
        },
        {
          element: <RequireVerifiedOrAccepter />,
          children: [{ path: '/requests/:id', element: <p>request page</p> }],
        },
      ],
      { initialEntries: ['/requests/22222222-2222-4222-8222-222222222222'] },
    );
    const navigations = vi.fn();
    router.subscribe(navigations);
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await new Promise((settle) => setTimeout(settle, 500));
    loaded();
    expect(await screen.findByText('verify page')).toBeInTheDocument();
    expect(errors.mock.calls.flat().join(' ')).not.toContain('Maximum update depth');
    expect(navigations.mock.calls.length).toBeLessThan(5);
    errors.mockRestore();
  });
});
