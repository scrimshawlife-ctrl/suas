import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider, type InitialEntry } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import { getMode, setMode } from '../../app/mode-store';
import CodePage from './CodePage';
import SignInPage from './SignInPage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function renderAt(entry: InitialEntry) {
  const router = createMemoryRouter(
    [
      { path: '/sign-in', element: <SignInPage /> },
      { path: '/sign-in/code', element: <CodePage /> },
      { path: '/home', element: <p>home page</p> },
      { path: '/serve', element: <p>serve page</p> },
      { path: '/requests/abc', element: <p>request abc page</p> },
    ],
    { initialEntries: [entry] },
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

beforeEach(() => {
  tokenStore.clear();
  setMode('support');
  client.POST.mockReset();
  client.GET.mockReset();
});

describe('Sign in', () => {
  it('preselects the role from ?role and has no demo note', () => {
    renderAt('/sign-in?role=serve');
    expect(screen.getByRole('radio', { name: /I want to serve/ })).toBeChecked();
    expect(screen.queryByText(/demo/i)).not.toBeInTheDocument();
  });

  it('asks for a valid email before calling the API', async () => {
    renderAt('/sign-in');
    await userEvent.click(screen.getByRole('button', { name: 'Send sign-in code' }));
    expect(screen.getByText('Enter your email address.')).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Email address')).toHaveFocus();
  });

  it('sends the code, stores the role as the mode and carries the email to the code step', async () => {
    client.POST.mockResolvedValue({ data: { status: 'accepted' } });
    renderAt('/sign-in?role=serve');
    await userEvent.type(screen.getByLabelText('Email address'), 'marcus@example.invalid');
    await userEvent.click(screen.getByRole('button', { name: 'Send sign-in code' }));
    expect(client.POST).toHaveBeenCalledWith('/api/v0/auth/challenges', {
      body: { destination: 'marcus@example.invalid', method: 'EMAIL_OTP' },
    });
    expect(await screen.findByRole('heading', { name: 'Enter the code' })).toBeInTheDocument();
    expect(screen.getByText('marcus@example.invalid')).toBeInTheDocument();
    expect(getMode()).toBe('serve');
  });

  it('says how long to wait on a 429', async () => {
    client.POST.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'slow down', 120));
    renderAt('/sign-in');
    await userEvent.type(screen.getByLabelText('Email address'), 'marcus@example.invalid');
    await userEvent.click(screen.getByRole('button', { name: 'Send sign-in code' }));
    expect(await screen.findByText('Too many tries. Try again in 2 minutes.')).toBeInTheDocument();
  });
});

describe('Enter code', () => {
  const session = {
    data: { session_credential: 'tok', expires_at: '2026-11-05T00:00:00Z', mfa_elevated: false },
  };

  it('sends a visitor with no email back to sign in', async () => {
    const router = renderAt('/sign-in/code');
    expect(await screen.findByRole('heading', { name: 'Join the mission' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('marks the code field required, as the board does', () => {
    renderAt({ pathname: '/sign-in/code', state: { email: 'a@example.invalid' } });
    expect(screen.getByLabelText('6-digit code')).toBeRequired();
  });

  it('ignores a from that leaves the app', async () => {
    client.POST.mockResolvedValue(session);
    renderAt({
      pathname: '/sign-in/code',
      state: { email: 'a@example.invalid', from: '//evil.test' },
    });
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
  });

  it('says how long to wait when the code step is rate limited', async () => {
    client.POST.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'slow down', 90));
    renderAt({ pathname: '/sign-in/code', state: { email: 'a@example.invalid' } });
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText('Too many tries. Try again in 2 minutes.')).toBeInTheDocument();
    expect(tokenStore.getToken()).toBeNull();
  });

  it('refuses a short code without calling the API', async () => {
    renderAt({ pathname: '/sign-in/code', state: { email: 'a@example.invalid' } });
    await userEvent.type(screen.getByLabelText('6-digit code'), '1234');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(screen.getByText('Enter all 6 digits.')).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();
    expect(screen.getByLabelText('6-digit code')).toHaveFocus();
  });

  it('shows the API message for a wrong or expired code and stores no session', async () => {
    client.POST.mockRejectedValue(new ApiError(401, 'INVALID_CODE', 'That code is not right.'));
    renderAt({ pathname: '/sign-in/code', state: { email: 'a@example.invalid' } });
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    expect(await screen.findByText('That code is not right.')).toBeInTheDocument();
    expect(tokenStore.getToken()).toBeNull();
  });

  it('goes to state.from after sign-in', async () => {
    client.POST.mockResolvedValue(session);
    renderAt({
      pathname: '/sign-in/code',
      state: { email: 'a@example.invalid', from: '/requests/abc' },
    });
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    await waitFor(() => expect(screen.getByText('request abc page')).toBeInTheDocument());
    expect(tokenStore.getToken()).toBe('tok');
  });

  it.each([
    ['support', 'home page'],
    ['serve', 'serve page'],
  ] as const)('goes by mode (%s) when there is no from', async (mode, page) => {
    setMode(mode);
    client.POST.mockResolvedValue(session);
    renderAt({ pathname: '/sign-in/code', state: { email: 'a@example.invalid' } });
    await userEvent.type(screen.getByLabelText('6-digit code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Verify and continue' }));
    await waitFor(() => expect(screen.getByText(page)).toBeInTheDocument());
  });
});
