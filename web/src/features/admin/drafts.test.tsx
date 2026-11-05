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

describe('draft detail edge cases', () => {
  it('shows the read-only banner, with focus on it, when a 409 means the draft was published', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValueOnce({ data: draft }).mockResolvedValue({
      data: { ...draft, status: 'PUBLISHED', reviewed_at: '2026-11-04T11:00:00.000Z' },
    });
    client.POST.mockRejectedValue(new ApiError(409, 'ILLEGAL_TRANSITION', 'already published'));
    renderDraft();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await user.click(await screen.findByRole('button', { name: 'Publish resource' }));
    const banner = await screen.findByText(/Published as a verified Resource/);
    expect(banner).toHaveAttribute('role', 'status');
    await waitFor(() => expect(banner).toHaveFocus());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('moves focus to the status line after a publish', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockResolvedValue({
      data: { draft: { ...draft, status: 'PUBLISHED' }, resource_id: 'r' },
    });
    renderDraft();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    await user.click(await screen.findByRole('button', { name: 'Publish resource' }));
    const banner = await screen.findByText(/Published as a verified Resource/);
    await waitFor(() => expect(banner).toHaveFocus());
  });

  it('clears "Changes saved." when the next edit starts', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockResolvedValue({
      data: { ...draft, cost: 'Free', updated_at: '2026-11-04T10:05:00.000Z' },
    });
    renderDraft();
    await user.type(await screen.findByLabelText('Cost'), 'Free');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Changes saved.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Hours'), '!');
    expect(screen.queryByText('Changes saved.')).not.toBeInTheDocument();
  });

  it('limits the service name to the server limit', async () => {
    client.GET.mockResolvedValue({ data: draft });
    renderDraft();
    expect(await screen.findByLabelText('Service name')).toHaveAttribute('maxLength', '200');
  });

  it('sends one save for a double click while the first is pending', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockReturnValue(new Promise(() => undefined));
    renderDraft();
    await user.type(await screen.findByLabelText('Cost'), 'Free');
    const save = screen.getByRole('button', { name: 'Save changes' });
    await user.click(save);
    await user.click(save);
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it('sends one publish for a double click on the confirm button', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue({ data: draft });
    client.POST.mockReturnValue(new Promise(() => undefined));
    renderDraft();
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const confirm = await screen.findByRole('button', { name: 'Publish resource' });
    await user.click(confirm);
    await user.click(screen.getByRole('button', { name: 'Working…' }));
    expect(client.POST).toHaveBeenCalledTimes(1);
  });

  it.each([502, 503])('says it could not load the draft on a %i', async (status) => {
    client.GET.mockRejectedValue(new ApiError(status, 'UPSTREAM', 'server text'));
    renderDraft();
    expect(await screen.findByText('We could not load this draft.')).toBeInTheDocument();
    expect(screen.queryByText('server text')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('renders the source as plain text when it is not an http link', async () => {
    client.GET.mockResolvedValue({ data: { ...draft, source_link: 'javascript:alert(1)' } });
    renderDraft();
    expect(await screen.findByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /javascript/ })).not.toBeInTheDocument();
  });
});

describe('draft list edge cases', () => {
  it('passes the cursor on "Show more" and hides the button on the last page', async () => {
    const user = userEvent.setup();
    const second = makeDraft({
      resource_draft_id: '22222222-2222-4222-8222-222222222222',
      service_name: 'Second Pantry',
    });
    client.GET.mockResolvedValueOnce({
      data: {
        builder: { available: true, message: null },
        drafts: [draft],
        limit: 20,
        next_cursor: 'cur-1',
      },
    }).mockResolvedValueOnce({
      data: {
        builder: { available: true, message: null },
        drafts: [second],
        limit: 20,
        next_cursor: null,
      },
    });
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    await user.click(await screen.findByRole('button', { name: 'Show more' }));
    expect(await screen.findByRole('link', { name: 'Second Pantry' })).toBeInTheDocument();
    expect(client.GET).toHaveBeenLastCalledWith('/api/v0/admin/resource-drafts', {
      params: { query: { status: 'DRAFT', limit: 20, cursor: 'cur-1' } },
    });
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it("shows Loading instead of the old tab's rows while another status loads", async () => {
    const user = userEvent.setup();
    client.GET.mockImplementation(
      (_path: string, options: { params: { query: { status: string } } }) =>
        options.params.query.status === 'DRAFT'
          ? Promise.resolve(listResponse(true))
          : new Promise(() => undefined),
    );
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    expect(await screen.findByRole('link', { name: draft.service_name })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Published' }));
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: draft.service_name })).not.toBeInTheDocument();
  });

  it('keeps the pasted text when no resources were found', async () => {
    const user = userEvent.setup();
    client.GET.mockResolvedValue(listResponse(true, []));
    client.POST.mockResolvedValue({ data: { drafts: [] } });
    renderAt([{ path: '/admin/drafts', element: <AdminDraftsPage /> }], ['/admin/drafts']);
    await user.type(await screen.findByLabelText('Source text'), 'Nothing useful here');
    await user.type(screen.getByLabelText('Source link'), 'https://a.example.invalid');
    await user.click(screen.getByRole('button', { name: 'Create drafts' }));
    expect(await screen.findByText(/No resources were found/)).toBeInTheDocument();
    expect(screen.getByLabelText('Source text')).toHaveValue('Nothing useful here');
    expect(screen.getByLabelText('Source link')).toHaveValue('https://a.example.invalid');
  });
});
