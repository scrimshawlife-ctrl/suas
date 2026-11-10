import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import CasePage from './CasePage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const SECRETS = ['1200 Example Ave, San Jose', 'Thursday, pick up at 9:30 AM', 'Marcus T.'];

const detail = (status = 'ACCEPTED') => ({
  service_request_id: 'r1',
  case_id: 'c1',
  category: 'FOOD',
  status,
  summary: 'Groceries for two days',
  timing: 'Thursday, pick up at 9:30 AM',
  meeting_place: '1200 Example Ave, San Jose',
  destination: null as string | null,
  created_at: '2026-11-04T12:00:00Z',
  accepted_at: null as string | null,
  widened: false,
  county: 'SANTA_CLARA',
  counterpart_display_name: 'Marcus T.',
});

type Reply = { data: unknown } | Error;
let replies: { detail: Reply; attempts: Reply };

function reply(value: Reply) {
  return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
}

function renderCase() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/serve/requests/r1']}>
        <Routes>
          <Route path="/serve/requests/:id" element={<CasePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const keyOf = (call: number) =>
  (client.POST.mock.calls[call]?.[1] as { headers: Record<string, string> }).headers[
    'Idempotency-Key'
  ];

beforeEach(() => {
  tokenStore.setToken('tok');
  client.GET.mockReset();
  client.POST.mockReset();
  replies = {
    detail: { data: detail() },
    attempts: { data: { contact_attempts: [] } },
  };
  client.GET.mockImplementation((path: string) => {
    if (path === '/api/v0/service-requests/{id}') return reply(replies.detail);
    if (path === '/api/v0/cases/{caseId}/contact-attempts') return reply(replies.attempts);
    return reply({ data: { service_requests: [] } });
  });
});

describe('Case page access', () => {
  async function notFoundText(): Promise<string> {
    const view = renderCase();
    await screen.findByRole('heading', { name: "We couldn't find that request." });
    for (const secret of SECRETS) expect(view.container).not.toHaveTextContent(secret);
    return view.container.textContent ?? '';
  }

  it('shows the same not-found page, with no request details, to a non-accepter (404)', async () => {
    replies.detail = new ApiError(404, 'NOT_FOUND', 'Resource not found.');
    expect(await notFoundText()).toContain("We couldn't find that request.");
  });

  it('shows the same copy to the requester, whose contact log answers 403', async () => {
    replies.attempts = new ApiError(403, 'FORBIDDEN', 'Reserved for the accepter.');
    const forbidden = await notFoundText();
    document.body.innerHTML = '';
    replies.detail = new ApiError(404, 'NOT_FOUND', 'Resource not found.');
    replies.attempts = { data: { contact_attempts: [] } };
    expect(await notFoundText()).toBe(forbidden);
  });
});

describe('Contact attempt saving', () => {
  it('posts "Waiting to hear" to log-contact-attempt and a settled outcome to complete-contact', async () => {
    client.POST.mockResolvedValue({ data: {} });
    renderCase();
    await screen.findByRole('button', { name: 'Save contact attempt' });
    await userEvent.click(screen.getByText('Waiting to hear'));
    await userEvent.click(screen.getByRole('button', { name: 'Save contact attempt' }));
    await screen.findByText('Saved.');
    expect(client.POST).toHaveBeenLastCalledWith(
      '/api/v0/cases/{caseId}/commands/log-contact-attempt',
      expect.objectContaining({ body: { channel: 'PHONE', outcome: 'PENDING' } }),
    );

    await userEvent.click(screen.getByText('Reached them'));
    await userEvent.click(screen.getByRole('button', { name: 'Save contact attempt' }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(2));
    expect(client.POST).toHaveBeenLastCalledWith(
      '/api/v0/cases/{caseId}/commands/complete-contact',
      expect.objectContaining({ body: { channel: 'PHONE', outcome: 'REACHED' } }),
    );
  });

  it('reuses the Idempotency-Key on retry and uses a new one after success', async () => {
    client.POST.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'x')).mockResolvedValue({
      data: {},
    });
    renderCase();
    const save = await screen.findByRole('button', { name: 'Save contact attempt' });
    await userEvent.click(save);
    await screen.findByText("That didn't save. Try again.");
    await userEvent.click(screen.getByRole('button', { name: 'Save contact attempt' }));
    await screen.findByText('Saved.');
    await userEvent.click(screen.getByRole('button', { name: 'Save contact attempt' }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(3));
    expect(keyOf(1)).toBe(keyOf(0));
    expect(keyOf(2)).not.toBe(keyOf(0));
  });
});

describe('History', () => {
  it('lists "You accepted" by time between the opened and contact rows, and not before accept', async () => {
    replies.detail = { data: { ...detail(), accepted_at: '2026-11-04T12:16:00Z' } };
    replies.attempts = {
      data: {
        contact_attempts: [
          {
            contact_attempt_id: 'a1',
            case_id: 'c1',
            logged_by_user_id: 'u1',
            channel: 'PHONE',
            outcome: 'REACHED',
            attempted_at: '2026-11-04T12:30:00Z',
          },
        ],
      },
    };
    const view = renderCase();
    const history = await screen.findByRole('region', { name: 'History' });
    await within(history).findByText('You accepted');
    const rows = within(history).getAllByRole('listitem');
    expect(rows.map((row) => row.querySelector('span.font-bold')?.textContent)).toEqual([
      'Request opened',
      'You accepted',
      'Phone call, reached Marcus',
    ]);
    view.unmount();

    replies.detail = { data: detail() };
    renderCase();
    const before = await screen.findByRole('region', { name: 'History' });
    await within(before).findByText('Request opened');
    expect(before).not.toHaveTextContent('You accepted');
  });
});

describe('Release', () => {
  it('is offered on an accepted request and opens the reason dialog', async () => {
    renderCase();
    await userEvent.click(await screen.findByRole('button', { name: 'Release this request' }));
    expect(screen.getByRole('dialog', { name: 'Release this request?' })).toBeInTheDocument();
  });

  it.each(['SUBMITTED', 'ASSIGNED', 'IN_PROGRESS', 'FULFILLED', 'EXPIRED'])(
    'is not offered while the status is %s',
    async (status) => {
      replies.detail = { data: detail(status) };
      renderCase();
      await screen.findByRole('region', { name: 'Progress' });
      expect(screen.queryByRole('button', { name: 'Release this request' })).toBeNull();
    },
  );

  it('is not offered to a non-accepter, who gets the not-found page', async () => {
    replies.detail = new ApiError(404, 'NOT_FOUND', 'Resource not found.');
    renderCase();
    await screen.findByRole('heading', { name: "We couldn't find that request." });
    expect(screen.queryByRole('button', { name: 'Release this request' })).toBeNull();
  });
});

describe('Progress step', () => {
  it.each([
    ['ACCEPTED', "I've started helping", 'START'],
    ['IN_PROGRESS', 'Mark as done', 'FULFILL'],
    ['CONFIRMED', 'Close this request', 'CLOSE'],
  ])('%s: "%s" is disabled while it is saving and runs once', async (status, label, command) => {
    replies.detail = { data: detail(status) };
    client.POST.mockReturnValue(new Promise(() => undefined));
    renderCase();
    await userEvent.dblClick(await screen.findByRole('button', { name: label }));
    expect(client.POST).toHaveBeenCalledTimes(1);
    expect(client.POST).toHaveBeenCalledWith(
      '/api/v0/service-requests/{id}/commands/{command}',
      expect.objectContaining({ params: { path: { id: 'r1', command } } }),
    );
    const saving = screen.getByRole('button', { name: 'Saving…' });
    expect(saving).toHaveAttribute('aria-disabled', 'true');
  });

  it('shows no step before the request is accepted', async () => {
    replies.detail = { data: detail('SUBMITTED') };
    renderCase();
    await screen.findByText('Taken, not started', { selector: 'span' });
    expect(screen.queryByRole('button', { name: /started helping|Mark as done/ })).toBeNull();
  });

  it('closes a confirmed request and then shows it as Closed, with no further step', async () => {
    replies.detail = { data: detail('CONFIRMED') };
    client.POST.mockImplementation(() => {
      replies.detail = { data: detail('CLOSED') };
      return Promise.resolve({ data: {} });
    });
    renderCase();
    await userEvent.click(await screen.findByRole('button', { name: 'Close this request' }));
    const progress = screen.getByRole('region', { name: 'Progress' });
    await waitFor(() => expect(within(progress).getByRole('status')).toHaveTextContent('Closed'));
    expect(within(progress).queryByRole('button')).toBeNull();
  });

  it('says it is waiting for the requester once it is marked as done', async () => {
    replies.detail = { data: detail('FULFILLED') };
    renderCase();
    expect(
      await screen.findByText("Waiting for Marcus T. to confirm it's done."),
    ).toBeInTheDocument();
  });
});

describe('Going to row', () => {
  it('shows the destination after "Where to meet" when one is set', async () => {
    replies.detail = { data: { ...detail(), category: 'TRANSPORTATION', destination: 'Clinic' } };
    renderCase();
    const row = await screen.findByText('Going to');
    expect(row.nextElementSibling).toHaveTextContent('Clinic');
    const labels = screen.getAllByRole('term').map((term) => term.textContent);
    expect(labels.indexOf('Going to')).toBe(labels.indexOf('Where to meet') + 1);
  });

  it('has no row when there is no destination', async () => {
    renderCase();
    await screen.findByText('Where to meet');
    expect(screen.queryByText('Going to')).not.toBeInTheDocument();
  });
});
