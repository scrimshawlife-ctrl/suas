import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import type { IntakeDraft, IntakeTurn } from './api';
import { FALLBACK_NOTICE } from './IntakeTurnView';
import RequestPage from './RequestPage';
import { renderScreen } from './test-utils';

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
  meeting_place: null,
  destination: null,
  service_request_id: null,
  created_at: '2026-11-04T00:00:00.000Z',
  updated_at: '2026-11-04T00:00:00.000Z',
  submitted_at: null,
};

function turn(overrides: Partial<IntakeTurn> = {}): IntakeTurn {
  return {
    outcome: 'DRAFT_READY',
    assistant_message: 'I drafted a food request.',
    not_available_yet: false,
    notice: null,
    draft,
    resources: [],
    request_form: null,
    ...overrides,
  };
}

const submitted = {
  service_request: { service_request_id: REQUEST_ID, status: 'SUBMITTED' },
  draft,
  replayed: false,
};

function available(value: boolean) {
  mocks.get.mockResolvedValue({
    data: { assistant_available: value, request_form: { method: 'POST', path: '/x' } },
  });
}

function postCalls(path: string) {
  return mocks.post.mock.calls.filter((call) => call[0] === path) as [
    string,
    { headers?: Record<string, string>; body?: unknown },
  ][];
}

beforeEach(() => {
  mocks.get.mockReset();
  mocks.post.mockReset();
  mocks.patch.mockReset();
});

async function talkToAssistant(text = 'I need groceries for the week.') {
  await userEvent.click(await screen.findByLabelText('Tell us what you need'));
  await userEvent.paste(text);
  await userEvent.click(screen.getByRole('button', { name: 'Send' }));
}

/** The assistant's part of the page: the plain form below it has the same field labels. */
const assistant = () => within(screen.getByRole('region', { name: 'Intake Assistant' }));

describe('RequestPage with the assistant', () => {
  beforeEach(() => {
    available(true);
    mocks.post.mockImplementation((path: string) => {
      if (path === '/api/v0/intake/drafts') return Promise.resolve({ data: turn() });
      return Promise.resolve({ data: submitted });
    });
    mocks.patch.mockImplementation((_path: string, options: { body: Record<string, unknown> }) =>
      Promise.resolve({ data: { ...draft, ...options.body } }),
    );
  });

  it('shows the draft card and saves edits with PATCH before the submit', async () => {
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library steps');
    await userEvent.click(assistant().getByRole('button', { name: 'Send request' }));

    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`/requests/${REQUEST_ID}`),
    );
    expect(mocks.patch.mock.calls.at(-1)?.[1]).toMatchObject({
      body: { meeting_place: 'Library steps' },
    });
    const patchOrder = mocks.patch.mock.invocationCallOrder.at(-1) ?? 0;
    const submitOrder = mocks.post.mock.invocationCallOrder.at(-1) ?? 0;
    expect(patchOrder).toBeLessThan(submitOrder);
  });

  it('shows the destination on a ride draft only and saves an edit with PATCH', async () => {
    const rideDraft = { ...draft, category: 'TRANSPORTATION' as const };
    mocks.post.mockImplementation((path: string) =>
      path === '/api/v0/intake/drafts'
        ? Promise.resolve({ data: turn({ draft: rideDraft }) })
        : Promise.resolve({ data: submitted }),
    );
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByLabelText(/Where are you going/));
    await userEvent.paste('Clinic');
    await userEvent.click(assistant().getByLabelText('Short summary'));
    await waitFor(() =>
      expect(mocks.patch.mock.calls.at(-1)?.[1]).toMatchObject({ body: { destination: 'Clinic' } }),
    );
  });

  it('has no destination field on a food draft', async () => {
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await assistant().findByLabelText('Where should the helper meet you?');
    expect(assistant().queryByLabelText(/Where are you going/)).not.toBeInTheDocument();
  });

  it('does not submit when the draft cannot be saved, and says so', async () => {
    mocks.patch.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'));
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library steps');
    await userEvent.click(assistant().getByRole('button', { name: 'Send request' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    expect(postCalls('/api/v0/intake/drafts/{id}/submit')).toHaveLength(0);
  });

  it('does not send a follow-up when the draft edits cannot be saved, and keeps the text', async () => {
    mocks.patch.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'));
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library steps');
    await userEvent.click(screen.getByLabelText('Tell us what you need'));
    await userEvent.paste('Also no dairy.');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(postCalls('/api/v0/intake/drafts/{id}/messages')).toHaveLength(0);
    expect(screen.getByLabelText('Tell us what you need')).toHaveValue('Also no dairy.');
  });

  it('reuses one Idempotency-Key when a failed submit is retried', async () => {
    let attempts = 0;
    mocks.post.mockImplementation((path: string) => {
      if (path === '/api/v0/intake/drafts') return Promise.resolve({ data: turn() });
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new ApiError(500, 'INTERNAL', 'boom'))
        : Promise.resolve({ data: submitted });
    });
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library steps');
    await userEvent.click(assistant().getByRole('button', { name: 'Send request' }));
    await screen.findByRole('alert');
    await userEvent.click(assistant().getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/requests/'));

    const keys = postCalls('/api/v0/intake/drafts/{id}/submit').map(
      (c) => c[1].headers?.['Idempotency-Key'],
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBeTruthy();
    expect(keys[1]).toBe(keys[0]);
  });

  it('disables the button while the submit is pending, so a second click sends nothing', async () => {
    mocks.post.mockImplementation((path: string) =>
      path === '/api/v0/intake/drafts'
        ? Promise.resolve({ data: turn() })
        : new Promise(() => undefined),
    );
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library steps');
    await userEvent.click(assistant().getByRole('button', { name: 'Send request' }));
    const pending = await assistant().findByRole('button', { name: 'Sending…' });
    expect(pending).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(pending);
    expect(postCalls('/api/v0/intake/drafts/{id}/submit')).toHaveLength(1);
  });

  it('maps a server 422 about the meeting place onto that field', async () => {
    mocks.post.mockImplementation((path: string) =>
      path === '/api/v0/intake/drafts'
        ? Promise.resolve({ data: turn({ draft: { ...draft, meeting_place: 'Library steps' } }) })
        : Promise.reject(
            new ApiError(422, 'UNPROCESSABLE', 'Say where to meet (meeting_place) first.'),
          ),
    );
    renderScreen(<RequestPage />);
    await talkToAssistant();
    await userEvent.click(await assistant().findByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText('Tell us where the helper should meet you.'),
    ).toBeInTheDocument();
  });

  it('moves to the plain form, with what was typed, when the assistant cannot answer', async () => {
    mocks.post.mockResolvedValue({
      data: turn({ outcome: 'FALLBACK_FORM', assistant_message: null, draft: null }),
    });
    renderScreen(<RequestPage />);
    await talkToAssistant('a'.repeat(300));
    const form = within(screen.getByRole('region', { name: 'Simple form' }));
    expect(await form.findByText(FALLBACK_NOTICE)).toBeInTheDocument();
    expect(form.getByLabelText('Short summary')).toHaveValue('a'.repeat(280));
    expect(
      screen.queryByRole('textbox', { name: 'Tell us what you need' }),
    ).not.toBeInTheDocument();
  });

  it('keeps what was entered in the plain form when the assistant falls back to it', async () => {
    mocks.post.mockResolvedValue({
      data: turn({ outcome: 'FALLBACK_FORM', assistant_message: null, draft: null }),
    });
    renderScreen(<RequestPage />, '/request?category=FOOD');
    const form = within(await screen.findByRole('region', { name: 'Simple form' }));
    await userEvent.click(form.getByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library steps');
    await talkToAssistant('I need groceries for the week.');
    expect(await form.findByText(FALLBACK_NOTICE)).toBeInTheDocument();
    expect(form.getByLabelText('Short summary')).toHaveValue('I need groceries for the week.');
    expect(form.getByLabelText('Where should the helper meet you?')).toHaveValue('Library steps');
    expect(form.getByLabelText('What kind of help do you need?')).toHaveValue('FOOD');
  });

  it('shows the plain form under the assistant, with no toggle (R5.15)', async () => {
    renderScreen(<RequestPage />);
    expect(await screen.findByLabelText('Tell us what you need')).toBeInTheDocument();
    const form = screen.getByRole('region', { name: 'Simple form' });
    expect(within(form).getByRole('heading', { name: 'Or fill in the form' })).toBeInTheDocument();
    expect(within(form).getByLabelText('Short summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
    expect(
      screen.queryByText('The assistant is not available right now. The form works the same.'),
    ).not.toBeInTheDocument();
  });

  it('sends the plain form while the assistant is available', async () => {
    mocks.post.mockResolvedValue({ data: { service_request_id: REQUEST_ID, status: 'SUBMITTED' } });
    renderScreen(<RequestPage />, '/request?category=PEER_SUPPORT');
    const form = within(await screen.findByRole('region', { name: 'Simple form' }));
    await userEvent.click(form.getByLabelText('Short summary'));
    await userEvent.paste('Someone to talk to');
    await userEvent.click(form.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`/requests/${REQUEST_ID}`),
    );
    expect(postCalls('/api/v0/service-requests')).toHaveLength(1);
    expect(postCalls('/api/v0/intake/drafts')).toHaveLength(0);
  });
});

describe('RequestPage without the assistant, and the plain form', () => {
  beforeEach(() => available(false));

  it('asks "Where are you going?" for a ride only and sends the destination', async () => {
    mocks.post.mockResolvedValue({ data: { service_request_id: REQUEST_ID, status: 'SUBMITTED' } });
    renderScreen(<RequestPage />, '/request?category=FOOD');
    await screen.findByLabelText('Short summary');
    expect(screen.queryByLabelText(/Where are you going/)).not.toBeInTheDocument();

    await userEvent.selectOptions(
      screen.getByLabelText('What kind of help do you need?'),
      'TRANSPORTATION',
    );
    await userEvent.click(screen.getByLabelText('Short summary'));
    await userEvent.paste('A ride to the clinic');
    await userEvent.click(screen.getByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library');
    await userEvent.click(screen.getByLabelText(/Where are you going/));
    await userEvent.paste('Clinic');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({
      body: { category: 'TRANSPORTATION', destination: 'Clinic' },
    });
  });

  it('drops the destination when the category changes away from a ride', async () => {
    mocks.post.mockResolvedValue({ data: { service_request_id: REQUEST_ID, status: 'SUBMITTED' } });
    renderScreen(<RequestPage />, '/request?category=TRANSPORTATION');
    await userEvent.click(await screen.findByLabelText(/Where are you going/));
    await userEvent.paste('Clinic');
    await userEvent.selectOptions(screen.getByLabelText('What kind of help do you need?'), 'FOOD');
    expect(screen.queryByLabelText(/Where are you going/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Short summary'));
    await userEvent.paste('Groceries');
    await userEvent.click(screen.getByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({ body: { category: 'FOOD' } });
    expect(mocks.post.mock.calls[0]?.[1]).not.toMatchObject({ body: { destination: 'Clinic' } });
  });

  it('shows only the form when the assistant is unavailable', async () => {
    renderScreen(<RequestPage />);
    expect(await screen.findByLabelText('Short summary')).toBeInTheDocument();
    expect(screen.queryByLabelText('Tell us what you need')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /simple form instead/ })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        'This sends a peer support request. It does not contact emergency services.',
      ),
    ).toBeInTheDocument();
  });

  it('pre-fills the category from ?category=', async () => {
    renderScreen(<RequestPage />, '/request?category=TRANSPORTATION');
    expect(await screen.findByLabelText('What kind of help do you need?')).toHaveValue(
      'TRANSPORTATION',
    );
  });

  it('ignores a category it does not know', async () => {
    renderScreen(<RequestPage />, '/request?category=LEGAL');
    expect(await screen.findByLabelText('What kind of help do you need?')).toHaveValue('');
  });

  it('puts focus on the first field with a problem and links its message to it', async () => {
    renderScreen(<RequestPage />, '/request?category=FOOD');
    await userEvent.click(await screen.findByLabelText('Short summary'));
    await userEvent.paste('Groceries');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    const meetingPlace = await screen.findByLabelText('Where should the helper meet you?');
    expect(meetingPlace).toHaveFocus();
    expect(meetingPlace).toHaveAttribute('aria-invalid', 'true');
    const message = screen.getByText('Tell us where the helper should meet you.');
    expect(meetingPlace.getAttribute('aria-describedby')?.split(' ')).toContain(message.id);
  });

  it('asks for a meeting place on a food request before sending anything', async () => {
    renderScreen(<RequestPage />, '/request?category=FOOD');
    await userEvent.click(await screen.findByLabelText('Short summary'));
    await userEvent.paste('Groceries');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText('Tell us where the helper should meet you.'),
    ).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('maps a server 422 about the meeting place onto that field', async () => {
    mocks.post.mockRejectedValue(
      new ApiError(422, 'UNPROCESSABLE', 'Say where to meet (meeting_place).'),
    );
    renderScreen(<RequestPage />, '/request?category=FOOD');
    await userEvent.click(await screen.findByLabelText('Short summary'));
    await userEvent.paste('Groceries');
    await userEvent.click(screen.getByLabelText('Where should the helper meet you?'));
    await userEvent.paste('Library');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    expect(
      await screen.findByText('Tell us where the helper should meet you.'),
    ).toBeInTheDocument();
  });

  it('sends a verification gate error to /verify and a county gate error to /welcome', async () => {
    mocks.post.mockRejectedValueOnce(new ApiError(403, 'VERIFICATION_REQUIRED', 'scan first'));
    renderScreen(<RequestPage />, '/request?category=PEER_SUPPORT');
    await userEvent.click(await screen.findByLabelText('Short summary'));
    await userEvent.paste('Someone to talk to');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/verify'));
  });

  it('creates the request and opens its status page', async () => {
    mocks.post.mockResolvedValue({ data: { service_request_id: REQUEST_ID, status: 'SUBMITTED' } });
    renderScreen(<RequestPage />, '/request?category=PEER_SUPPORT');
    await userEvent.click(await screen.findByLabelText('Short summary'));
    await userEvent.paste('Someone to talk to');
    await userEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`/requests/${REQUEST_ID}`),
    );
    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({
      body: { category: 'PEER_SUPPORT', summary: 'Someone to talk to' },
    });
  });
});
