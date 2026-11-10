import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import AdminMfaPage from './AdminMfaPage';
import { mfaReturnPath } from './mfa';
import { renderAt } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function renderMfa(state?: unknown) {
  return renderAt(
    [
      { path: '/admin/mfa', element: <AdminMfaPage /> },
      { path: '/admin', element: <p>overview page</p> },
      { path: '/admin/drafts', element: <p>drafts page</p> },
    ],
    [{ pathname: '/admin/mfa', state }],
  );
}

beforeEach(() => {
  tokenStore.setToken('tok');
  client.POST.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe('MFA step-up', () => {
  it('starts a check, never fills the response, and elevates on a valid answer', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValueOnce({
      data: { challenge_id: 'mfa-test-3', factor_type: 'TEST_FACTOR' },
    }).mockResolvedValueOnce({ data: { mfa_elevated: true } });
    renderMfa({ from: '/admin/drafts' });

    expect(screen.getByRole('heading', { name: 'Confirm it is you' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Start check' }));

    expect(await screen.findByText(/This environment uses a test check/)).toBeInTheDocument();
    const field = screen.getByLabelText('Your response');
    expect(field).toHaveValue('');
    expect(screen.getByText(/Dev build only/)).toBeInTheDocument();

    await user.type(field, 'ok-mfa-test-3');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByText('drafts page')).toBeInTheDocument());
    expect(client.POST).toHaveBeenLastCalledWith('/api/v0/auth/mfa/challenges/commands/verify', {
      body: { challenge_id: 'mfa-test-3', response: 'ok-mfa-test-3' },
    });
    expect(tokenStore.isMfaElevated()).toBe(true);
  });

  it('hides the format hint outside dev builds', async () => {
    vi.stubEnv('DEV', false);
    client.POST.mockResolvedValueOnce({
      data: { challenge_id: 'mfa-test-1', factor_type: 'TEST_FACTOR' },
    });
    renderMfa();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start check' }));
    expect(await screen.findByLabelText('Your response')).toBeInTheDocument();
    expect(screen.queryByText(/Dev build only/)).not.toBeInTheDocument();
  });

  it('says plainly when admin sign-in is unavailable', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(503, 'MFA_UNAVAILABLE', 'No MFA factor'));
    renderMfa();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start check' }));
    expect(
      await screen.findByText('Admin sign-in is not available in this environment.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check/i })).not.toBeInTheDocument();
  });

  it('asks for a new check after a wrong response and stays not elevated', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValueOnce({
      data: { challenge_id: 'mfa-test-1', factor_type: 'TEST_FACTOR' },
    }).mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHENTICATED', 'The MFA response is not valid.'),
    );
    renderMfa();
    await user.click(screen.getByRole('button', { name: 'Start check' }));
    await user.type(await screen.findByLabelText('Your response'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/That response did not match/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a new check' })).toBeInTheDocument();
    expect(tokenStore.isMfaElevated()).toBe(false);
  });

  it('asks for a response before sending', async () => {
    const user = userEvent.setup();
    client.POST.mockResolvedValueOnce({
      data: { challenge_id: 'mfa-test-1', factor_type: 'TEST_FACTOR' },
    });
    renderMfa();
    await user.click(screen.getByRole('button', { name: 'Start check' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm' }));
    expect(screen.getByText('Enter your response.')).toBeInTheDocument();
    // Like the other forms, focus moves to the field so the error is announced (ADMIN-2).
    await waitFor(() => expect(screen.getByLabelText('Your response')).toHaveFocus());
    expect(client.POST).toHaveBeenCalledTimes(1);
  });
});

describe('mfaReturnPath', () => {
  it('returns an admin page it came from, otherwise the overview', () => {
    expect(mfaReturnPath({ from: '/admin/drafts/abc' })).toBe('/admin/drafts/abc');
    expect(mfaReturnPath({ from: '/admin/mfa' })).toBe('/admin');
    expect(mfaReturnPath({ from: '/admin?x=1' })).toBe('/admin?x=1');
    expect(mfaReturnPath({ from: '/admin/drafts?status=PUBLISHED' })).toBe(
      '/admin/drafts?status=PUBLISHED',
    );
    expect(mfaReturnPath({ from: '/admin/mfa?x' })).toBe('/admin');
    expect(mfaReturnPath({ from: '/administrator' })).toBe('/admin');
    expect(mfaReturnPath({ from: 42 })).toBe('/admin');
    expect(mfaReturnPath({ from: '/home' })).toBe('/admin');
    expect(mfaReturnPath({ from: '//evil.example' })).toBe('/admin');
    expect(mfaReturnPath(null)).toBe('/admin');
  });
});
