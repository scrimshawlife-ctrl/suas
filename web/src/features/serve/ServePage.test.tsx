import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  tokenStore.setToken('tok');
  client.GET.mockReset();
  client.POST.mockReset();
  listed = [open('r1', 'Groceries for two days'), open('r2', null)];
  client.GET.mockImplementation(
    (path: string, options?: { params?: { query?: { ownership?: string } } }) => {
      if (path === '/api/v0/veterans/me') {
        return Promise.resolve({ data: { display_name: 'Dee R.', county: 'SANTA_CLARA' } });
      }
      if (path === '/api/v0/notifications') return Promise.resolve({ data: { notifications: [] } });
      if (options?.params?.query?.ownership === 'mine') {
        return Promise.resolve({ data: { service_requests: [], next_cursor: null } });
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
});
