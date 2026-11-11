import { screen } from '@testing-library/react';
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
