import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { IntakeDraft } from './api';
import { isDraftGone, openDraft } from './open-draft';
import RequestPage from './RequestPage';
import { renderScreen } from './test-utils';

/** R12.1: the open draft's id survives a reload in sessionStorage; the draft is read back. */
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock('../../api/client', () => ({
  api: { GET: mocks.get, POST: mocks.post, PATCH: mocks.patch },
}));

const DRAFT_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_ID = '44444444-4444-4444-8444-444444444444';

const draft: IntakeDraft = {
  draft_id: DRAFT_ID,
  status: 'DRAFT',
  category: 'FOOD',
  summary: 'Groceries for the week',
  timing: null,
  meeting_place: 'Library steps',
  destination: null,
  service_request_id: null,
  created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z',
  submitted_at: null,
};
const TYPED = 'I could use some groceries this week.';

/** GET /intake/status says the assistant is on; GET /intake/drafts/{id} answers `draftRead`. */
function serve(draftRead: () => Promise<unknown>) {
  mocks.get.mockImplementation((path: string) =>
    path === '/api/v0/intake/drafts/{id}'
      ? draftRead()
      : Promise.resolve({ data: { assistant_available: true, request_form: null } }),
  );
}

const assistant = () => within(screen.getByRole('region', { name: 'Intake Assistant' }));
const draftReads = () =>
  mocks.get.mock.calls.filter((call) => call[0] === '/api/v0/intake/drafts/{id}');

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
});

describe('draft resume after a reload (R12.1)', () => {
  it('reads nothing when no draft id is stored', async () => {
    serve(() => Promise.reject(new Error('not called')));
    renderScreen(<RequestPage />);
    await screen.findByLabelText('Tell us what you need');
    expect(draftReads()).toHaveLength(0);
  });

  it('shows the stored open draft with the typed text, and clears the id on submit', async () => {
    openDraft.set(DRAFT_ID);
    serve(() => Promise.resolve({ data: { ...draft, intake_text: TYPED } }));
    mocks.post.mockResolvedValue({
      data: {
        service_request: { service_request_id: REQUEST_ID, status: 'SUBMITTED' },
        draft,
        replayed: false,
      },
    });
    renderScreen(<RequestPage />);

    expect(await screen.findByText(TYPED)).toBeInTheDocument();
    expect(assistant().getByLabelText('Short summary')).toHaveValue('Groceries for the week');
    expect(draftReads()[0]?.[1]).toEqual({ params: { path: { id: DRAFT_ID } } });

    await userEvent.click(assistant().getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`/requests/${REQUEST_ID}`),
    );
    expect(openDraft.get()).toBeNull();
  });

  it('forgets a draft that is no longer DRAFT and shows nothing of it', async () => {
    openDraft.set(DRAFT_ID);
    serve(() => Promise.resolve({ data: { ...draft, status: 'SUBMITTED', intake_text: TYPED } }));
    renderScreen(<RequestPage />);
    await waitFor(() => expect(openDraft.get()).toBeNull());
    expect(screen.queryByText(TYPED)).toBeNull();
    expect(screen.queryByRole('region', { name: 'Check your request' })).toBeNull();
  });

  it('forgets a draft the server no longer has (404)', async () => {
    openDraft.set(DRAFT_ID);
    serve(() => Promise.reject(new ApiError(404, 'NOT_FOUND', 'x')));
    renderScreen(<RequestPage />);
    await waitFor(() => expect(openDraft.get()).toBeNull());
  });

  it('keeps the id when the read fails for another reason', async () => {
    openDraft.set(DRAFT_ID);
    serve(() => Promise.reject(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x')));
    renderScreen(<RequestPage />);
    await waitFor(() => expect(draftReads().length).toBeGreaterThan(0));
    expect(openDraft.get()).toBe(DRAFT_ID);
  });

  it('stores the id of a new draft the assistant made', async () => {
    serve(() => Promise.reject(new Error('not called')));
    mocks.post.mockResolvedValue({
      data: {
        outcome: 'DRAFT_READY',
        assistant_message: 'Drafted.',
        not_available_yet: false,
        notice: null,
        draft,
        resources: [],
        request_form: null,
      },
    });
    renderScreen(<RequestPage />);
    await userEvent.click(await screen.findByLabelText('Tell us what you need'));
    await userEvent.paste(TYPED);
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(openDraft.get()).toBe(DRAFT_ID));
  });
});

describe('isDraftGone', () => {
  it('is true for 404 and 409 ILLEGAL_TRANSITION only', () => {
    expect(isDraftGone(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(true);
    expect(isDraftGone(new ApiError(409, 'ILLEGAL_TRANSITION', 'x'))).toBe(true);
    // Another message or edit won the race: the draft is still open.
    expect(isDraftGone(new ApiError(409, 'STALE_STATE', 'x'))).toBe(false);
    expect(isDraftGone(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(false);
  });
});
