import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys';
import { tokenStore } from '../api/token-store';
import { RequireSignedIn } from './guards';
import { useSignOut } from './useSignOut';

const post = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ api: { POST: post } }));

function SignOutButton() {
  const signOut = useSignOut();
  return <button onClick={() => void signOut()}>Sign out</button>;
}

function setup() {
  tokenStore.setToken('tok');
  const queryClient = new QueryClient();
  queryClient.setQueryData(queryKeys.me, { display_name: 'Marcus T.' });
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>landing</p> },
      { path: '/sign-in', element: <p>sign in</p> },
      { element: <RequireSignedIn />, children: [{ path: '/home', element: <SignOutButton /> }] },
    ],
    { initialEntries: ['/home'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

beforeEach(() => {
  tokenStore.clear();
  post.mockReset();
});

describe('sign out', () => {
  it('ends on "/" with no stale `from`, then clears the token and cache', async () => {
    post.mockResolvedValue({});
    const { router, queryClient } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('landing')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(router.state.location.state).toBeNull();
    expect(post).toHaveBeenCalledWith('/api/v0/auth/sessions/commands/logout');
    expect(tokenStore.getToken()).toBeNull();
    expect(queryClient.getQueryData(queryKeys.me)).toBeUndefined();
  });

  it('still signs out locally when the server call fails', async () => {
    post.mockRejectedValue(new Error('offline'));
    const { router } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('landing')).toBeInTheDocument();
    expect(router.state.location.state).toBeNull();
    expect(tokenStore.getToken()).toBeNull();
  });
});
