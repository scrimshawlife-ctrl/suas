import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import AdminConsentTemplatesPage from './AdminConsentTemplatesPage';
import type { ConsentTemplateVersion } from './consent-templates-api';
import { renderPage } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

function version(overrides: Partial<ConsentTemplateVersion> = {}): ConsentTemplateVersion {
  return {
    version_key: 'red-alert-trusted-contact@2',
    template_key: 'red-alert-trusted-contact',
    version: 2,
    status: 'DRAFT',
    body: 'Synthetic test template, version 2.',
    published_at: null,
    created_at: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  tokenStore.setToken('tok', { mfaElevated: true });
  client.GET.mockReset();
  client.POST.mockReset();
  client.GET.mockResolvedValue({
    data: {
      templates: [
        version(),
        version({
          version_key: 'red-alert-trusted-contact@1',
          version: 1,
          status: 'PUBLISHED',
          published_at: '2026-11-11T10:00:00Z',
        }),
      ],
    },
  });
});

describe('Consent templates admin page (R9.3)', () => {
  it('lists versions with their status and offers Publish only on a draft', async () => {
    renderPage(<AdminConsentTemplatesPage />);
    expect(await screen.findByText('red-alert-trusted-contact@2')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Published')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Publish / })).toHaveLength(1);
  });

  it('checks the key before saving, then saves a draft with one Idempotency-Key', async () => {
    client.POST.mockResolvedValue({ data: { ...version({ version: 3 }), replayed: false } });
    const user = userEvent.setup();
    renderPage(<AdminConsentTemplatesPage />);
    await user.type(screen.getByLabelText(/Template key/), 'Bad Key');
    await user.type(screen.getByLabelText(/Template text/), 'Synthetic test template.');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(await screen.findByText(/Use lowercase letters/)).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText(/Template key/));
    await user.type(screen.getByLabelText(/Template key/), 'red-alert-trusted-contact');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST).toHaveBeenCalledWith('/api/v0/admin/consent-templates', {
      body: { template_key: 'red-alert-trusted-contact', body: 'Synthetic test template.' },
      headers: { 'Idempotency-Key': expect.any(String) as string },
    });
  });

  it('publishes a draft after the confirm step', async () => {
    client.POST.mockResolvedValue({
      data: { ...version({ status: 'PUBLISHED' }), superseded_version_keys: [] },
    });
    const user = userEvent.setup();
    renderPage(<AdminConsentTemplatesPage />);
    await user.click(
      await screen.findByRole('button', { name: 'Publish red-alert-trusted-contact@2' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        '/api/v0/admin/consent-templates/{version}/commands/publish',
        { params: { path: { version: 'red-alert-trusted-contact@2' } } },
      ),
    );
  });

  // The route takes no Idempotency-Key: publish only moves a DRAFT, so a repeat (a retry after
  // a lost response) is a 409. The page says so and rereads the list to show the version now.
  it('a publish answered 409 says it may already be published and rereads the list', async () => {
    client.POST.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'x'));
    const user = userEvent.setup();
    renderPage(<AdminConsentTemplatesPage />);
    await user.click(
      await screen.findByRole('button', { name: 'Publish red-alert-trusted-contact@2' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Publish' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'It may already be published.',
    );
    await waitFor(() => expect(client.GET).toHaveBeenCalledTimes(2));
  });

  // With no key to dedupe on, the page itself must send one publish per confirm.
  it('sends one publish on a same-tick double click on the confirm button', async () => {
    client.POST.mockReturnValue(new Promise(() => undefined));
    const user = userEvent.setup();
    renderPage(<AdminConsentTemplatesPage />);
    await user.click(
      await screen.findByRole('button', { name: 'Publish red-alert-trusted-contact@2' }),
    );
    const confirm = within(await screen.findByRole('dialog')).getByRole('button', {
      name: 'Publish',
    });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(await screen.findByRole('button', { name: 'Working…' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(client.POST).toHaveBeenCalledTimes(1);
  });
});
