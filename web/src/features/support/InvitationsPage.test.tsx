import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../request/test-utils';
import InvitationsPage from './InvitationsPage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const invitation = {
  trusted_contact_id: 'tc-1',
  veteran_display_name: 'Marcus T.',
  relationship_label: 'Sister',
};

beforeEach(() => {
  client.GET.mockReset();
  client.POST.mockReset();
});

describe('Invitations (R9.4)', () => {
  it('shows the display name and relationship, and Accept calls the accept command once', async () => {
    client.GET.mockResolvedValueOnce({ data: { invitations: [invitation] } });
    client.GET.mockResolvedValue({ data: { invitations: [] } });
    client.POST.mockResolvedValue({
      data: {
        trusted_contact_id: 'tc-1',
        relationship_label: 'Sister',
        status: 'ACCEPTED',
        contact_user_id: 'u-2',
        replayed: false,
      },
    });
    const user = userEvent.setup();
    renderScreen(<InvitationsPage />, '/invitations');

    expect(await screen.findByText('Marcus T.')).toBeInTheDocument();
    expect(screen.getByText('They listed you as: Sister')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept the invitation from Marcus T.' }));

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledWith('/api/v0/trusted-contacts/{id}/commands/accept', {
      params: { path: { id: 'tc-1' } },
      headers: { 'Idempotency-Key': expect.any(String) as string },
    });
    expect(
      await screen.findByText('Accepted. They can now choose what SUAS may tell you.'),
    ).toBeInTheDocument();
    expect(await screen.findByText('You have no invitations.')).toBeInTheDocument();
  });

  it('names nobody when the Veteran has no display name', async () => {
    client.GET.mockResolvedValue({
      data: { invitations: [{ ...invitation, veteran_display_name: null }] },
    });
    renderScreen(<InvitationsPage />, '/invitations');
    expect(await screen.findByText('A veteran')).toBeInTheDocument();
  });
});
