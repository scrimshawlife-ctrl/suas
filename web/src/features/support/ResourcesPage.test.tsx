import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
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
  contacts: [],
  area: null,
  verified_at: '2026-10-28T19:00:00Z',
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

describe('Resource card', () => {
  const card = (name: string) =>
    within(screen.getByRole('heading', { name }).closest('li') as HTMLElement);

  it('shows every contact as its own action, the area and the verified date', async () => {
    respond({
      first: {
        resources: [
          {
            ...listing('a'),
            area: 'San José, east side',
            contacts: [
              { kind: 'PHONE', value: '(408) 555-0142' },
              { kind: 'URL', value: 'https://example.org' },
              { kind: 'EMAIL', value: 'help@example.org' },
            ],
          },
        ],
        limit: 10,
        total: 1,
        next_cursor: null,
      },
    });
    renderResources();
    await screen.findByRole('heading', { name: 'Pantry a' });
    const a = card('Pantry a');
    expect(a.getByRole('link', { name: 'Call Pantry a at (408) 555-0142' })).toHaveAttribute(
      'href',
      'tel:4085550142',
    );
    expect(a.getByRole('link', { name: 'Visit website' })).toHaveAttribute(
      'href',
      'https://example.org/',
    );
    expect(a.getByRole('link', { name: 'Email help@example.org' })).toBeInTheDocument();
    expect(a.getByText('San José, east side')).toBeInTheDocument();
    expect(a.queryByText('Santa Clara')).not.toBeInTheDocument();
    expect(a.getByText('Verified Oct 28')).toBeInTheDocument();
    expect(a.queryByText('This listing may be out of date.')).not.toBeInTheDocument();
  });

  it('falls back to the counties, shows the stale warning, and says when there is no contact', async () => {
    respond({
      first: {
        resources: [
          {
            ...listing('b'),
            freshness: 'STALE',
            stale_warning: true,
            verified_at: '2026-07-02T19:00:00Z',
          },
        ],
        limit: 10,
        total: 1,
        next_cursor: null,
      },
    });
    renderResources();
    await screen.findByRole('heading', { name: 'Pantry b' });
    const b = card('Pantry b');
    expect(b.getByText('Santa Clara')).toBeInTheDocument();
    expect(b.getByText('Verified Jul 2')).toBeInTheDocument();
    expect(b.getByText('This listing may be out of date.')).toBeInTheDocument();
    expect(b.getByText('No contact method recorded.')).toBeInTheDocument();
    expect(b.queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows free text as written, not as a link', async () => {
    respond({
      first: {
        resources: [
          { ...listing('c'), contacts: [{ kind: 'FREEFORM', value: 'Ask at the desk' }] },
        ],
        limit: 10,
        total: 1,
        next_cursor: null,
      },
    });
    renderResources();
    await screen.findByRole('heading', { name: 'Pantry c' });
    const c = card('Pantry c');
    expect(c.getByText('Ask at the desk')).toBeInTheDocument();
    expect(c.queryByRole('link')).not.toBeInTheDocument();
    expect(c.queryByText('No contact method recorded.')).not.toBeInTheDocument();
  });
});
