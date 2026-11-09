import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RequestsPage from './RequestsPage';
import { renderScreen } from './test-utils';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { GET: get, POST: vi.fn() } }));

function item(n: number) {
  return {
    service_request_id: `00000000-0000-4000-8000-00000000000${n}`,
    case_id: '11111111-1111-4111-8111-111111111111',
    category: 'FOOD',
    status: 'MATCHING',
    summary: `Request ${n}`,
    created_at: '2026-11-04T19:42:00.000Z',
  };
}

beforeEach(() => {
  get.mockReset();
});

describe('RequestsPage', () => {
  it('lists the requests and loads the next page from next_cursor on Show more', async () => {
    get
      .mockResolvedValueOnce({ data: { service_requests: [item(1), item(2)], next_cursor: 'c1' } })
      .mockResolvedValueOnce({ data: { service_requests: [item(3)], next_cursor: null } });
    renderScreen(<RequestsPage />, '/requests');

    expect(await screen.findByText('Request 1')).toBeInTheDocument();
    expect(screen.getByText('Request 2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Your requests', level: 1 })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));

    expect(await screen.findByText('Request 3')).toBeInTheDocument();
    const [path, options] = get.mock.lastCall as [string, { params: { query: object } }];
    expect(path).toBe('/api/v0/service-requests');
    expect(options.params.query).toMatchObject({ ownership: 'requested', cursor: 'c1' });
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});
