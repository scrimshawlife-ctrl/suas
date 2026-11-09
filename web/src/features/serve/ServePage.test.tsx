import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/errors';
import { tokenStore } from '../../api/token-store';
import ServePage from './ServePage';

const client = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const open = (id: string, summary: string | null) => ({
  service_request_id: id,
  case_id: `case-${id}`,
  category: 'FOOD',
  status: 'SUBMITTED',
  county: 'SANTA_CLARA',
  widened: false,
  summary,
  created_at: new Date(Date.now() - 12 * 60_000).toISOString(),
  // The API never sends these on the open list; the board must not show them even if it did.
  meeting_place: '1200 Example Ave, San Jose',
  timing: 'Thursday, pick up at 9:30 AM',
  counterpart_display_name: 'Marcus T.',
});

function renderServe() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/serve']}>
        <Routes>
          <Route path="/serve" element={<ServePage />} />
          <Route path="/serve/requests/:id" element={<p>case opened</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

let listed: ReturnType<typeof open>[];
let mineCounts: { helping_now: number; closed_last_30_days: number } | undefined;
let mine: { service_requests: ReturnType<typeof open>[]; next_cursor: string | null };

beforeEach(() => {
  tokenStore.setToken('tok');
  client.GET.mockReset();
  client.POST.mockReset();
  listed = [open('r1', 'Groceries for two days'), open('r2', null)];
  mineCounts = undefined;
  mine = { service_requests: [], next_cursor: null };
  client.GET.mockImplementation(
    (path: string, options?: { params?: { query?: { ownership?: string } } }) => {
      if (path === '/api/v0/veterans/me') {
        return Promise.resolve({ data: { display_name: 'Dee R.', county: 'SANTA_CLARA' } });
      }
      if (path === '/api/v0/notifications') return Promise.resolve({ data: { notifications: [] } });
      if (options?.params?.query?.ownership === 'mine') {
        return Promise.resolve({ data: { ...mine, counts: mineCounts } });
      }
      return Promise.resolve({ data: { service_requests: listed, next_cursor: null } });
    },
  );
});

describe('Serve board', () => {
  it('lists open requests with the category fallback and greets by first name', async () => {
    renderServe();
    expect(await screen.findByText('Groceries for two days')).toBeInTheDocument();
    expect(screen.getByText('Food', { selector: 'span' })).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Ready to serve, Dee.' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Santa Clara County, newest first')).toBeInTheDocument();
  });

  it('summarises from the server counts, and falls back to the list when they are absent', async () => {
    mineCounts = { helping_now: 2, closed_last_30_days: 4 };
    const first = renderServe();
    const summary = await screen.findByRole('region', { name: 'Your summary' });
    expect(await within(summary).findByText('Closed in the last 30 days')).toBeInTheDocument();
    expect(summary).toHaveTextContent(/You're helping now2Closed in the last 30 days4/);
    first.unmount();

    mineCounts = undefined;
    renderServe();
    const fallback = await screen.findByRole('region', { name: 'Your summary' });
    await waitFor(() => expect(fallback).toHaveTextContent(/You're helping now0/));
    expect(fallback).not.toHaveTextContent('Closed in the last 30 days');
  });

  it('removes the card and says so when someone else took the request (409)', async () => {
    client.POST.mockRejectedValue(new ApiError(409, 'ALREADY_CLAIMED', 'taken'));
    renderServe();
    await screen.findByText('Groceries for two days');
    listed = [open('r2', null)]; // the refetch no longer includes r1
    await userEvent.click(screen.getByRole('button', { name: /Take this request: Groceries/ }));
    expect(await screen.findByText('Someone else took this one.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Groceries for two days')).not.toBeInTheDocument(),
    );
  });

  it('opens the case after a successful accept', async () => {
    client.POST.mockResolvedValue({ data: { service_request_id: 'r1', case_id: 'case-r1' } });
    renderServe();
    await screen.findByText('Groceries for two days');
    await userEvent.click(screen.getByRole('button', { name: /Take this request: Groceries/ }));
    expect(await screen.findByText('case opened')).toBeInTheDocument();
    expect(client.POST).toHaveBeenCalledWith(
      '/api/v0/service-requests/{id}/accept',
      expect.objectContaining({ params: { path: { id: 'r1' } } }),
    );
  });

  it('shows no meeting place, timing or requester name on the open list', async () => {
    renderServe();
    await screen.findByText('Groceries for two days');
    const board = screen.getByRole('region', { name: 'Open requests' });
    for (const hidden of ['1200 Example Ave', 'Thursday, pick up', 'Marcus']) {
      expect(board).not.toHaveTextContent(hidden);
    }
  });

  it('sends an Idempotency-Key with the accept', async () => {
    client.POST.mockResolvedValue({ data: { service_request_id: 'r1', case_id: 'case-r1' } });
    renderServe();
    await screen.findByText('Groceries for two days');
    await userEvent.click(screen.getByRole('button', { name: /Take this request: Groceries/ }));
    await screen.findByText('case opened');
    const options = client.POST.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(options.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends exactly one accept on a double click and locks every take button meanwhile', async () => {
    client.POST.mockReturnValue(new Promise(() => undefined));
    renderServe();
    await screen.findByText('Groceries for two days');
    await userEvent.dblClick(screen.getByRole('button', { name: /Take this request: Groceries/ }));
    expect(client.POST).toHaveBeenCalledTimes(1);
    const taking = screen.getByRole('button', { name: /Taking this request: Groceries/ });
    expect(taking).toHaveAttribute('aria-busy', 'true');
    expect(taking).toHaveAttribute('aria-disabled', 'true');
    expect(taking).toHaveTextContent('Taking it…');
    // The other card waits too, so a second request cannot start.
    expect(screen.getByRole('button', { name: /Take this request: Food/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it("shows the helper's active count in the summary", async () => {
    mine = {
      service_requests: [
        { ...open('m1', 'Ride to the clinic'), status: 'ACCEPTED' },
        { ...open('m2', 'Dinner'), status: 'CONFIRMED' },
        { ...open('m3', 'Old ride'), status: 'CLOSED' },
      ],
      next_cursor: null,
    };
    renderServe();
    const summary = await screen.findByRole('region', { name: 'Your summary' });
    await waitFor(() => expect(summary).toHaveTextContent("You're helping now2"));
  });

  it('shows a dash, not a short count, when the helper has more requests than one page', async () => {
    mine = {
      service_requests: [{ ...open('m1', 'Ride to the clinic'), status: 'ACCEPTED' }],
      next_cursor: 'more',
    };
    renderServe();
    await screen.findByText('Ride to the clinic');
    const summary = screen.getByRole('region', { name: 'Your summary' });
    expect(summary).toHaveTextContent("You're helping now–");
  });
});
