import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { queryKeys } from '../../api/keys';
import { tokenStore } from '../../api/token-store';
import type { Me } from '../../api/types';
import SettingsPage from './SettingsPage';

/** R12.2: Settings changes the display name and county with the Welcome validation. */
const client = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const me: Me = {
  user_id: '11111111-1111-4111-8111-111111111111',
  status: 'ACTIVE',
  enrolled_channels: { email: true, phone: false },
  county: 'SANTA_CLARA',
  display_name: 'Marcus T.',
  is_admin: false,
  id_verification: { method: 'ID_SCAN_SELFIE', status: 'VERIFIED', verified_at: null },
  open_case: null,
  active_qrf: null,
  categories: [],
};

function renderSettings() {
  tokenStore.setToken('tok');
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, me);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const nameField = () => screen.getByLabelText('Name other veterans will see');
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save changes' }));

beforeEach(() => {
  client.GET.mockReset();
  client.GET.mockResolvedValue({ data: me });
  client.PUT.mockReset();
  client.PUT.mockResolvedValue({ data: {} });
});

describe('Settings', () => {
  it('starts from the current name and county', () => {
    renderSettings();
    expect(nameField()).toHaveValue('Marcus T.');
    expect(screen.getByLabelText('County')).toHaveValue('SANTA_CLARA');
  });

  it('sends only the county when only the county changed', async () => {
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText('County'), 'MERCED');
    await save();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(client.PUT).toHaveBeenCalledTimes(1);
    expect(client.PUT).toHaveBeenCalledWith('/api/v0/veterans/me/county', {
      body: { county: 'MERCED' },
    });
  });

  it('sends the trimmed name when only the name changed', async () => {
    renderSettings();
    await userEvent.clear(nameField());
    await userEvent.type(nameField(), '  Mark T. ');
    await save();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(client.PUT).toHaveBeenCalledTimes(1);
    expect(client.PUT).toHaveBeenCalledWith('/api/v0/veterans/me/profile', {
      body: { display_name: 'Mark T.' },
    });
  });

  it('uses the Welcome validation and sends nothing for an empty name', async () => {
    renderSettings();
    await userEvent.clear(nameField());
    await save();
    expect(screen.getByText('Enter the name other veterans will see.')).toBeInTheDocument();
    expect(nameField()).toHaveFocus();
    expect(client.PUT).not.toHaveBeenCalled();
  });

  it('says so when the save fails', async () => {
    client.PUT.mockRejectedValue(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x'));
    renderSettings();
    await userEvent.selectOptions(screen.getByLabelText('County'), 'MERCED');
    await save();
    expect(
      await screen.findByText('We could not save that. Check your connection and try again.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});
