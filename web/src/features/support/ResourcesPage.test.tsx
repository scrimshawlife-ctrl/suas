import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenStore } from '../../api/token-store';
import ResourcesPage from './ResourcesPage';

const client = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock('../../api/client', () => ({ api: client }));

const listing = (id: string) => ({
  resource_id: id,
  service_name: `Pantry ${id}`,
  category: 'FOOD',
  counties: ['SANTA_CLARA'],
  hours: null,
  cost: null,
  contact_method: null,
  contact_method_kind: null,
  freshness: 'FRESH',
  stale_warning: false,
});

function respond(pages: Record<string, unknown>) {
  client.GET.mockImplementation(
    (path: string, options?: { params?: { query?: { cursor?: string } } }) => {
      if (path === '/api/v0/veterans/me') {
        return Promise.resolve({ data: { display_name: 'Dee R.', county: 'SANTA_CLARA' } });
      }
      return Promise.resolve({ data: pages[options?.params?.query?.cursor ?? 'first'] });
    },
  );
}

function renderResources() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/resources/food']}>
        <Routes>
          <Route path="/resources/:category" element={<ResourcesPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  tokenStore.setToken('tok');
  client.GET.mockReset();
});

describe('Resources listing count', () => {
  it('counts every loaded page against the server total', async () => {
    respond({
      first: { resources: [listing('a'), listing('b')], limit: 2, total: 3, next_cursor: 'c2' },
      c2: { resources: [listing('c')], limit: 2, total: 3, next_cursor: null },
    });
    renderResources();
    expect(await screen.findByText('Showing 2 of 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show more listings' }));
    expect(await screen.findByText('Showing 3 of 3')).toBeInTheDocument();
  });

  it('hides the count when nothing matches', async () => {
    respond({ first: { resources: [], limit: 10, total: 0, next_cursor: null } });
    renderResources();
    expect(await screen.findByText('No listings for your county yet.')).toBeInTheDocument();
    expect(screen.queryByText(/Showing/)).not.toBeInTheDocument();
  });
});
