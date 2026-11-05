import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../../api/keys';
import { tokenStore } from '../../api/token-store';
import type { Me } from '../../api/types';
import WelcomePage from './WelcomePage';

const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const base: Me = {
  user_id: '11111111-1111-4111-8111-111111111111',
  status: 'ACTIVE',
  enrolled_channels: { email: true, phone: false },
  county: null,
  display_name: null,
  is_admin: false,
  id_verification: { method: 'ID_SCAN_SELFIE', status: 'NOT_STARTED', verified_at: null },
  open_case: null,
  active_qrf: null,
  categories: [],
};

function renderWelcome(me: Me) {
  tokenStore.setToken('tok');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, me);
  const router = createMemoryRouter(
    [
      { path: '/welcome', element: <WelcomePage /> },
      { path: '/home', element: <p>home page</p> },
    ],
    { initialEntries: ['/welcome'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tokenStore.clear();
  client.GET.mockReset();
  client.PUT.mockReset();
});

describe('Welcome', () => {
  it('asks for both values and does not call the API', async () => {
    renderWelcome(base);
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    expect(screen.getByText('Enter the name other veterans will see.')).toBeInTheDocument();
    expect(screen.getByText('Choose your county.')).toBeInTheDocument();
    expect(client.PUT).not.toHaveBeenCalled();
  });

  it('pre-fills from me', () => {
    renderWelcome({ ...base, display_name: 'Marcus T.', county: 'ALAMEDA' });
    expect(screen.getByLabelText('Name other veterans will see')).toHaveValue('Marcus T.');
    expect(screen.getByLabelText('County')).toHaveValue('ALAMEDA');
  });

  it('saves the name, then the county, then continues', async () => {
    client.PUT.mockResolvedValue({ data: undefined });
    client.GET.mockResolvedValue({
      data: { ...base, display_name: 'Marcus T.', county: 'MERCED' },
    });
    renderWelcome(base);
    await userEvent.type(screen.getByLabelText('Name other veterans will see'), ' Marcus T. ');
    await userEvent.selectOptions(screen.getByLabelText('County'), 'Merced');
    await userEvent.click(screen.getByRole('button', { name: 'Save and continue' }));
    await waitFor(() => expect(screen.getByText('home page')).toBeInTheDocument());
    expect(client.PUT.mock.calls.map((call: unknown[]) => call[0])).toEqual([
      '/api/v0/veterans/me/profile',
      '/api/v0/veterans/me/county',
    ]);
    expect(client.PUT.mock.calls[0]?.[1]).toEqual({ body: { display_name: 'Marcus T.' } });
    expect(client.PUT.mock.calls[1]?.[1]).toEqual({ body: { county: 'MERCED' } });
  });
});
