import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RequestDetailPage from './RequestDetailPage';
import { renderScreen } from './test-utils';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { GET: get, POST: vi.fn() } }));

const ID = '11111111-1111-4111-8111-111111111111';

function detail(viewer_role: 'REQUESTER' | 'ACCEPTER', overrides: Record<string, unknown> = {}) {
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
    destination: null,
    viewer_role,
    ...overrides,
  };
}

function backend(role: 'REQUESTER' | 'ACCEPTER', overrides: Record<string, unknown> = {}) {
  get.mockImplementation((path: string) => {
    if (path === '/api/v0/veterans/me') {
      return Promise.resolve({ data: { active_qrf: null, categories: [] } });
    }
    return Promise.resolve({ data: detail(role, overrides) });
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

describe('RequestDetailPage edit action and destination', () => {
  const open = (overrides: Record<string, unknown> = {}) => {
    backend('REQUESTER', overrides);
    renderScreen(<RequestDetailPage />, `/requests/${ID}`, '/requests/:id');
  };

  it.each(['SUBMITTED', 'TRIAGED', 'MATCHING'])('offers Edit request while %s', async (status) => {
    open({ status });
    expect(await screen.findByRole('button', { name: 'Edit request' })).toBeInTheDocument();
  });

  it.each(['ACCEPTED', 'FULFILLED', 'CANCELLED', 'EXPIRED', 'UNFULFILLABLE'])(
    'does not offer Edit request once %s',
    async (status) => {
      open({ status });
      await screen.findByRole('heading', { name: 'What you sent' });
      expect(screen.queryByRole('button', { name: 'Edit request' })).not.toBeInTheDocument();
    },
  );

  it('opens the edit form with the category fixed, and closes it on Cancel', async () => {
    open({ status: 'MATCHING' });
    await userEvent.click(await screen.findByRole('button', { name: 'Edit request' }));
    expect(screen.getByLabelText('Short summary')).toHaveValue('Groceries');
    expect(screen.getByLabelText('What kind of help do you need?')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Short summary')).not.toBeInTheDocument();
  });

  it('shows "Going to" for a ride with a destination', async () => {
    open({ status: 'MATCHING', category: 'TRANSPORTATION', destination: 'Clinic on Main St' });
    expect(await screen.findByText('Going to')).toBeInTheDocument();
    expect(screen.getByText('Clinic on Main St')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Only you and the person who accepts this request see the meeting place and where you are going.',
      ),
    ).toBeInTheDocument();
  });

  it('has no "Going to" row without a destination', async () => {
    open({ status: 'MATCHING', category: 'TRANSPORTATION' });
    await screen.findByRole('heading', { name: 'What you sent' });
    expect(screen.queryByText('Going to')).not.toBeInTheDocument();
    expect(
      screen.getByText('Only you and the person who accepts this request see the meeting place.'),
    ).toBeInTheDocument();
  });
});
