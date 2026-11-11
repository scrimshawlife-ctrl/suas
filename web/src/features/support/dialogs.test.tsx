import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentGrant, TrustedContact } from './api';
import { RemoveContactDialog } from './RemoveContactDialog';
import { StopSharingDialog } from './StopSharingDialog';
import { redAlertGrantBody } from './red-alert-consent';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const grant: ConsentGrant = {
  consent_grant_id: 'g1',
  ...redAlertGrantBody('tc-1'),
  status: 'ACTIVE',
  granted_at: '2026-11-04T10:00:00Z',
  expires_at: null,
  revoked_at: null,
};
const contact: TrustedContact = {
  trusted_contact_id: 'tc-1',
  relationship_label: 'Sister',
  status: 'ACCEPTED',
  contact_user_id: 'u-2',
};

function withClient(children: ReactNode) {
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      {children}
    </QueryClientProvider>
  );
}

beforeEach(() => {
  client.POST.mockReset();
  client.POST.mockResolvedValue({ data: {} });
});

describe('StopSharingDialog', () => {
  function open() {
    const handlers = { onClose: vi.fn(), onStopped: vi.fn() };
    render(
      withClient(
        <StopSharingDialog grant={grant} who="Your trusted contact: Sister" {...handlers} />,
      ),
    );
    return handlers;
  }

  it('opens with focus inside, on the safe Close control and not on Stop sharing', async () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Stop sharing?' });
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus(),
    );
    expect(within(dialog).getByRole('button', { name: 'Stop sharing' })).not.toHaveFocus();
  });

  it('Keep sharing and Escape close without revoking', async () => {
    const user = userEvent.setup();
    const handlers = open();
    await user.click(screen.getByRole('button', { name: 'Keep sharing' }));
    await user.keyboard('{Escape}');
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
    expect(client.POST).not.toHaveBeenCalled();
    expect(handlers.onStopped).not.toHaveBeenCalled();
  });

  it('Stop sharing revokes the grant with a key, then reports it stopped', async () => {
    const user = userEvent.setup();
    const handlers = open();
    await user.click(screen.getByRole('button', { name: 'Stop sharing' }));
    await waitFor(() => expect(handlers.onStopped).toHaveBeenCalled());
    expect(client.POST).toHaveBeenCalledWith('/api/v0/consents/{id}/commands/revoke', {
      params: { path: { id: 'g1' } },
      headers: { 'Idempotency-Key': expect.any(String) as string },
    });
  });
});

describe('double click in a dialog', () => {
  it('Stop sharing sends one revoke and reports it stopped', async () => {
    const handlers = { onClose: vi.fn(), onStopped: vi.fn() };
    render(withClient(<StopSharingDialog grant={grant} who="Sister" {...handlers} />));
    const button = screen.getByRole('button', { name: 'Stop sharing' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(handlers.onStopped).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it('Remove sends one revoke and one remove and reports it removed', async () => {
    const handlers = { onClose: vi.fn(), onRemoved: vi.fn() };
    render(withClient(<RemoveContactDialog contact={contact} grants={[grant]} {...handlers} />));
    const button = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(handlers.onRemoved).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledTimes(2);
  });
});

describe('RemoveContactDialog', () => {
  function open(grants: ConsentGrant[]) {
    const handlers = { onClose: vi.fn(), onRemoved: vi.fn() };
    render(withClient(<RemoveContactDialog contact={contact} grants={grants} {...handlers} />));
    return handlers;
  }

  it('opens with focus on Close; Keep and Escape close without removing', async () => {
    const user = userEvent.setup();
    const handlers = open([grant]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Keep' }));
    await user.keyboard('{Escape}');
    expect(handlers.onClose).toHaveBeenCalledTimes(2);
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('revokes the ACTIVE RED grant first, then removes, each with its own key', async () => {
    const user = userEvent.setup();
    const handlers = open([grant]);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(handlers.onRemoved).toHaveBeenCalled());
    const calls = client.POST.mock.calls as [string, { headers: Record<string, string> }][];
    expect(calls.map((c) => c[0])).toEqual([
      '/api/v0/consents/{id}/commands/revoke',
      '/api/v0/trusted-contacts/{id}/commands/remove',
    ]);
    expect(calls[0]![1]).toMatchObject({ params: { path: { id: 'g1' } } });
    expect(calls[1]![1]).toMatchObject({ params: { path: { id: 'tc-1' } } });
    const keys = calls.map((c) => c[1].headers['Idempotency-Key']);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBeTruthy();
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('only removes when there is no ACTIVE RED grant', async () => {
    const user = userEvent.setup();
    const handlers = open([{ ...grant, status: 'REVOKED' }]);
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(handlers.onRemoved).toHaveBeenCalled());
    expect((client.POST.mock.calls as [string][]).map((c) => c[0])).toEqual([
      '/api/v0/trusted-contacts/{id}/commands/remove',
    ]);
  });
});
