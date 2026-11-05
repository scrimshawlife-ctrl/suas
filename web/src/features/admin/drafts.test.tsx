import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import AdminDraftPage from './AdminDraftPage';
import AdminDraftsPage from './AdminDraftsPage';
import { renderAt, makeDraft } from './test-utils';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const draft = makeDraft();
const id = draft.resource_draft_id;

function renderDraft() {
  return renderAt(
    [
      { path: '/admin/drafts/:id', element: <AdminDraftPage /> },
      { path: '/admin/drafts', element: <p>drafts list</p> },
    ],
    [`/admin/drafts/${id}`],
  );
}

function listResponse(available: boolean, drafts = [draft]) {
  return {
    data: {
      builder: { available, message: available ? null : 'Builder is down.' },
      drafts,
      limit: 20,
      next_cursor: null,
    },
  };
}

beforeEach(() => {
  tokenStore.setToken('tok');
  client.GET.mockReset();
  client.POST.mockReset();
});

describe('draft detail', () => {
  it('edits only what changed, and saves through the edit command', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockResolvedValue({ data: { ...draft, cost: 'Free' } });
    renderDraft();
    await user.type(await screen.findByLabelText('Cost'), 'Free');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(client.POST).toHaveBeenCalled());
    expect(client.POST).toHaveBeenCalledWith(
      '/api/v0/admin/resource-drafts/{id}/commands/edit',
      expect.objectContaining({ params: { path: { id } }, body: { cost: 'Free' } }),
    );
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
  });

  it('opens the source in a new tab without leaking the opener', async () => {
    client.GET.mockResolvedValue({ data: draft });
    renderDraft();
    const link = await screen.findByRole('link', { name: /pantry\.example\.invalid/ });
    expect(link).toHaveAttribute('href', draft.source_link);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('asks before publishing and sends nothing until confirmed', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockResolvedValue({
      data: {
        draft: { ...draft, status: 'PUBLISHED', reviewed_at: '2026-11-04T11:00:00.000Z' },
        resource_id: 'r1',
      },
    });
    renderDraft();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const dialog = await screen.findByRole('dialog', { name: 'Publish this resource?' });
    expect(
      within(dialog).getByText('Publishing makes this a verified Resource that veterans can see.'),
    ).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await user.click(await screen.findByRole('button', { name: 'Publish resource' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        '/api/v0/admin/resource-drafts/{id}/commands/publish',
        expect.objectContaining({ params: { path: { id } } }),
      ),
    );
    // Published drafts become read-only.
    expect(await screen.findByText(/Published as a verified Resource/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
  });

  it('asks before discarding', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockResolvedValue({ data: { ...draft, status: 'REJECTED' } });
    renderDraft();
    await user.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(client.POST).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));
    await waitFor(() =>
      expect(client.POST).toHaveBeenCalledWith(
        '/api/v0/admin/resource-drafts/{id}/commands/discard',
        expect.anything(),
      ),
    );
    expect(await screen.findByText(/Discarded\. This draft was not published/)).toBeInTheDocument();
  });

  it('holds publish and discard while there are unsaved changes', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    renderDraft();
    await user.type(await screen.findByLabelText('Cost'), 'Free');
    expect(screen.getByRole('button', { name: 'Publish' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText(/Save your changes before/)).toBeInTheDocument();
  });

  it('shows a published draft read-only', async () => {
    client.GET.mockResolvedValue({ data: { ...draft, status: 'PUBLISHED' } });
    renderDraft();
    expect(await screen.findByText(/Published as a verified Resource/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Cost')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
  });

  it('explains a publish that raced with another change', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'already published'));
    renderDraft();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await user.click(await screen.findByRole('button', { name: 'Publish resource' }));
    expect(await screen.findByText(/already published or discarded/)).toBeInTheDocument();
  });
});

describe('draft list and extraction', () => {
  it('shows the builder message and blocks extraction when the builder is unavailable', async () => {
    client.GET.mockResolvedValue(listResponse(false));
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    expect(await screen.findByText('Builder is down.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create drafts' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('filters by status and lists drafts', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue(listResponse(true));
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    expect(await screen.findByRole('link', { name: draft.service_name })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Published' }));
    await waitFor(() =>
      expect(client.GET).toHaveBeenLastCalledWith('/api/v0/admin/resource-drafts', {
        params: { query: { status: 'PUBLISHED', limit: 20 } },
      }),
    );
  });

  it('checks the text and link before sending', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue(listResponse(true));
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    await user.click(await screen.findByRole('button', { name: 'Create drafts' }));
    expect(screen.getByText('Paste the source text.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Source text'), 'Valley Pantry');
    await user.type(screen.getByLabelText('Source link'), 'ftp://x.example.invalid');
    await user.click(screen.getByRole('button', { name: 'Create drafts' }));
    expect(screen.getByText(/starts with http/)).toBeInTheDocument();
    expect(client.POST).not.toHaveBeenCalled();
  });

  it('shows the created drafts', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue(listResponse(true, []));
    client.POST.mockResolvedValue({ data: { drafts: [draft] } });
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    await user.type(await screen.findByLabelText('Source text'), 'Willow Creek Pantry');
    await user.type(screen.getByLabelText('Source link'), 'https://pantry.example.invalid/hours');
    await user.click(screen.getByRole('button', { name: 'Create drafts' }));
    expect(await screen.findByText(/Created 1 draft/)).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith(
      '/api/v0/admin/resource-drafts/commands/extract',
      expect.objectContaining({
        body: {
          source_text: 'Willow Creek Pantry',
          source_link: 'https://pantry.example.invalid/hours',
        },
      }),
    );
  });

  it.each([
    ['CATALOG_BUILDER_UNAVAILABLE', 503, /catalog builder is not available/],
    ['CATALOG_EXTRACTION_FAILED', 502, /could not read this text/],
  ])('answers %s honestly', async (code, status, text) => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue(listResponse(true, []));
    client.POST.mockRejectedValue(new ApiError(status, code, 'server text that must not show'));
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    await user.type(await screen.findByLabelText('Source text'), 'text');
    await user.type(screen.getByLabelText('Source link'), 'https://a.example.invalid');
    await user.click(screen.getByRole('button', { name: 'Create drafts' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent('server text that must not show');
  });
});
