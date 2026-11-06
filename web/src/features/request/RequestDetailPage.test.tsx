import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RequestDetailPage from './RequestDetailPage';
import { renderScreen } from './test-utils';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { GET: get, POST: vi.fn() } }));

const ID = '11111111-1111-4111-8111-111111111111';

function detail(viewer_role: 'REQUESTER' | 'ACCEPTER') {
  return {
    service_request_id: ID,
    case_id: ID,
    category: 'FOOD',
    status: 'ACCEPTED',
    summary: 'Groceries',
    timing: null,
    meeting_place: 'Library steps',
    created_at: '2026-11-04T19:42:00.000Z',
    widened: false,
    county: 'SANTA_CLARA',
    counterpart_display_name: 'Marcus T.',
    viewer_role,
  };
}

function backend(role: 'REQUESTER' | 'ACCEPTER') {
  get.mockImplementation((path: string) => {
    if (path === '/api/v0/veterans/me') {
      return Promise.resolve({ data: { active_qrf: null, categories: [] } });
    }
    return Promise.resolve({ data: detail(role) });
  });
}

beforeEach(() => {
  get.mockReset();
});

describe('RequestDetailPage viewer role', () => {
  it('sends the person who accepted to the Serve case page', async () => {
    backend('ACCEPTER');
    renderScreen(<RequestDetailPage />, `/requests/${ID}`, '/requests/:id');
    await vi.waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(`/serve/requests/${ID}`),
    );
  });

  it('keeps the requester on the status page', async () => {
    backend('REQUESTER');
    renderScreen(<RequestDetailPage />, `/requests/${ID}`, '/requests/:id');
    expect(await screen.findByRole('heading', { name: 'Your request' })).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(`/requests/${ID}`);
  });
});
