import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMode } from '../../app/mode-store';
import { renderScreen } from '../request/test-utils';
import NotificationsPage from './NotificationsPage';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { GET: get, POST: vi.fn() } }));

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ data: { notifications: [] } });
});

afterEach(() => setMode('support'));

describe('Notifications "Back to home"', () => {
  it('returns a helper who came from Serve to the Serve board', () => {
    setMode('serve');
    renderScreen(<NotificationsPage />, '/notifications');
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/serve');
  });

  it('returns anyone in Need support mode to Home', () => {
    setMode('support');
    renderScreen(<NotificationsPage />, '/notifications');
    expect(screen.getByRole('link', { name: 'Back to home' })).toHaveAttribute('href', '/home');
  });
});

const notice = (id: string, reason: string, sent_at: string) => ({
  notification_id: id,
  reason,
  channel: 'IN_APP',
  delivery_status: 'SENT',
  attempt_count: 1,
  subject_type: null,
  subject_id: null,
  sent_at,
  cancelled_at: null,
});

describe('Notifications paging', () => {
  it('loads older notifications by next_cursor on Show more, then hides the button', async () => {
    get
      .mockResolvedValueOnce({
        data: {
          notifications: [notice('n1', 'service_request_expired', '2026-11-04T00:00:00Z')],
          next_cursor: 'c1',
        },
      })
      .mockResolvedValueOnce({
        data: {
          notifications: [notice('n2', 'service_request_released', '2026-11-03T00:00:00Z')],
          next_cursor: null,
        },
      });
    renderScreen(<NotificationsPage />, '/notifications');
    expect(await screen.findByText(/Your request expired/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show more' }));
    expect(await screen.findByText(/The helper released your request/)).toBeInTheDocument();
    expect(get).toHaveBeenLastCalledWith('/api/v0/notifications', {
      params: { query: { limit: 50, cursor: 'c1' } },
    });
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });
});
