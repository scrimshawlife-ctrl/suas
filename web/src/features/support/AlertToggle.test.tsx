import { QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { createQueryClient } from '../../app/query-client';
import { tokenStore } from '../../api/token-store';
import type { ConsentGrant, TrustedContact } from './api';
import { ALERT_LABEL, ALERT_OFF, ALERT_ON, ALERT_UNAVAILABLE, AlertToggle } from './AlertToggle';
import { redAlertGrantBody } from './red-alert-consent';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn(), PUT: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const contact: TrustedContact = {
  trusted_contact_id: 'tc-1',
  relationship_label: 'Sister',
  status: 'ACCEPTED',
  contact_user_id: 'u-2',
};

const VERSION = 'red-alert-trusted-contact@1';
const published = {
  version_key: VERSION,
  template_key: 'red-alert-trusted-contact',
  version: 1,
  body: 'Synthetic test template.',
  published_at: '2026-11-04T09:00:00Z',
};

const activeGrant: ConsentGrant = {
  consent_grant_id: 'g1',
  ...redAlertGrantBody('tc-1', VERSION),
  status: 'ACTIVE',
  granted_at: '2026-11-04T10:00:00Z',
  expires_at: null,
  revoked_at: null,
};

function wrap(grants: readonly ConsentGrant[] | undefined) {
  return (
    // The app's own client, so a 404 template read is final as it is in the app.
    <QueryClientProvider client={createQueryClient()}>
      <AlertToggle contact={contact} grants={grants} />
    </QueryClientProvider>
  );
}

function keyOf(call: unknown[]): string {
  return (call[1] as { headers: Record<string, string> }).headers['Idempotency-Key']!;
}

beforeEach(() => {
  client.POST.mockReset();
  client.GET.mockReset();
  client.GET.mockResolvedValue({ data: published });
  tokenStore.setToken('tok');
});

/** The switch, once the published template has loaded and it accepts changes. */
async function readySwitch() {
  const toggle = screen.getByRole('switch', { name: ALERT_LABEL });
  await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
  return toggle;
}

/** Turns the switch on through the consent confirm step (R12.3). */
async function turnOn(user: ReturnType<typeof userEvent.setup>, toggle: HTMLElement) {
  await user.click(toggle);
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Turn on' }));
}

describe('AlertToggle', () => {
  it('is off with no grant, shows the template text, and posts the exact RED grant body on confirm', async () => {
    client.POST.mockResolvedValue({ data: activeGrant });
    const user = userEvent.setup();
    render(wrap([]));
    const toggle = await readySwitch();
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(ALERT_OFF)).toBeInTheDocument();

    await user.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Turn on this alert?' });
    expect(within(dialog).getByText('Synthetic test template.')).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Turn on' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledWith('/api/v0/consents', {
      body: redAlertGrantBody('tc-1', VERSION),
      headers: { 'Idempotency-Key': expect.any(String) as string },
    });
  });

  it('is on when an ACTIVE RED grant exists, and turning it off revokes that grant', async () => {
    client.POST.mockResolvedValue({ data: { ...activeGrant, status: 'REVOKED' } });
    const user = userEvent.setup();
    render(wrap([activeGrant]));
    const toggle = await readySwitch();
    expect(toggle).toBeChecked();
    expect(screen.getByText(ALERT_ON)).toBeInTheDocument();

    await user.click(toggle);
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledWith('/api/v0/consents/{id}/commands/revoke', {
      params: { path: { id: 'g1' } },
      headers: { 'Idempotency-Key': expect.any(String) as string },
    });
  });

  it('sends nothing when the confirm step is cancelled', async () => {
    const user = userEvent.setup();
    render(wrap([]));
    const toggle = await readySwitch();
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(toggle).not.toBeChecked();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('cannot be turned on when the published template has no text, and posts nothing', async () => {
    client.GET.mockResolvedValue({ data: { ...published, body: '  ' } });
    const user = userEvent.setup();
    render(wrap([]));
    expect(await screen.findByText(ALERT_UNAVAILABLE)).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('cannot be turned on when the template read fails, and offers to try again', async () => {
    client.GET.mockImplementation(() =>
      Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'x')),
    );
    const user = userEvent.setup();
    render(wrap([]));
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('says alerts cannot be turned on when the template is unavailable', async () => {
    client.POST.mockImplementation(() =>
      Promise.reject(new ApiError(422, 'CONSENT_TEMPLATE_UNAVAILABLE', 'x')),
    );
    const user = userEvent.setup();
    render(wrap([]));
    await turnOn(user, await readySwitch());
    expect(await screen.findByText(ALERT_UNAVAILABLE)).toBeInTheDocument();
  });

  it('says alerts cannot be turned on when no RED template is published, and posts nothing', async () => {
    client.GET.mockImplementation(() => Promise.reject(new ApiError(404, 'NOT_FOUND', 'x')));
    const user = userEvent.setup();
    render(wrap([]));
    expect(await screen.findByText(ALERT_UNAVAILABLE)).toBeInTheDocument();
    await user.click(screen.getByRole('switch'));
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('keeps focus and ignores clicks while saving', async () => {
    let finish: (value: unknown) => void = () => undefined;
    client.POST.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    render(wrap([]));
    const toggle = await readySwitch();
    await turnOn(user, toggle);
    expect(await screen.findByText('Saving…')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-disabled', 'true');
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveFocus();

    await user.click(toggle);
    expect(client.POST).toHaveBeenCalledTimes(1);
    finish({ data: activeGrant });
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
  });

  it('sends one grant on a same-tick double click of Turn on and shows no error', async () => {
    client.POST.mockResolvedValue({ data: activeGrant });
    render(wrap([]));
    const toggle = await readySwitch();
    fireEvent.click(toggle);
    const confirm = screen.getByRole('button', { name: 'Turn on' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
    expect(client.POST).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cites the re-read template with a new key after a superseded one (M2)', async () => {
    client.POST.mockImplementationOnce(() =>
      Promise.reject(new ApiError(422, 'CONSENT_TEMPLATE_UNAVAILABLE', 'x')),
    );
    client.POST.mockResolvedValue({ data: activeGrant });
    const next = { ...published, version_key: 'red-alert-trusted-contact@2', version: 2 };
    client.GET.mockResolvedValueOnce({ data: published }).mockResolvedValue({ data: next });
    const user = userEvent.setup();
    render(wrap([]));
    await turnOn(user, await readySwitch());
    await waitFor(() => expect(client.GET).toHaveBeenCalledTimes(2));
    await turnOn(user, await readySwitch());
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    const [first, retry] = client.POST.mock.calls;
    expect((retry![1] as { body: unknown }).body).toMatchObject({
      consent_template_version: 'red-alert-trusted-contact@2',
    });
    // Same key with a new body is a 409 IDEMPOTENCY_CONFLICT on the server.
    expect(keyOf(retry!)).not.toBe(keyOf(first!));
  });

  it('reuses the key on a retry after an error and renews it only after a success', async () => {
    client.POST.mockImplementationOnce(() => Promise.reject(new ApiError(503, 'UNAVAILABLE', 'x')));
    client.POST.mockResolvedValue({ data: activeGrant });
    const user = userEvent.setup();
    const { rerender } = render(wrap([]));
    await turnOn(user, await readySwitch());
    await screen.findByRole('alert');
    await turnOn(user, screen.getByRole('switch'));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    const [first, retry] = client.POST.mock.calls;
    expect(keyOf(retry!)).toBe(keyOf(first!));

    // The grant now exists; the next action (turning it off) gets a new key.
    await waitFor(() => expect(screen.queryByText('Saving…')).toBeNull());
    rerender(wrap([activeGrant]));
    await user.click(screen.getByRole('switch'));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(3));
    expect(keyOf(client.POST.mock.calls[2]!)).not.toBe(keyOf(first!));
  });
});
