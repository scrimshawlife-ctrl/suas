import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../request/test-utils';
import HomePage from './HomePage';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../api/client', () => ({ api: { GET: get, POST: vi.fn() } }));

function backend(status: 'VERIFIED' | 'NOT_STARTED', unfinished: boolean) {
  get.mockImplementation((path: string) => {
    if (path === '/api/v0/veterans/me') {
      return Promise.resolve({
        data: {
          display_name: 'Pat V.',
          active_qrf: null,
          categories: [],
          id_verification: { method: 'ID_SCAN_SELFIE', status, verified_at: null },
        },
      });
    }
    if (path === '/api/v0/check-ins') {
      return Promise.resolve({
        data: { check_ins: unfinished ? [{ check_in_id: 'c1', status: 'IN_PROGRESS' }] : [] },
      });
    }
    return Promise.resolve({ data: { service_requests: [], next_cursor: null } });
  });
}

beforeEach(() => {
  get.mockReset();
});

describe('Home Check-In card', () => {
  it('offers Continue Check-In while an unfinished one can be resumed', async () => {
    backend('VERIFIED', true);
    renderScreen(<HomePage />, '/home');
    expect(await screen.findByRole('link', { name: 'Continue Check-In' })).toHaveAttribute(
      'href',
      '/check-in',
    );
    expect(screen.queryByRole('link', { name: 'Start Check-In' })).toBeNull();
  });

  it('offers Start Check-In when none is unfinished', async () => {
    backend('VERIFIED', false);
    renderScreen(<HomePage />, '/home');
    expect(await screen.findByRole('link', { name: 'Start Check-In' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Continue Check-In' })).toBeNull();
  });

  it('does not read the list before the ID check, and still offers Start Check-In', async () => {
    backend('NOT_STARTED', true);
    renderScreen(<HomePage />, '/home');
    expect(await screen.findByRole('link', { name: 'Start Check-In' })).toBeInTheDocument();
    expect(get).not.toHaveBeenCalledWith('/api/v0/check-ins', expect.anything());
  });

  it('does not promise a number of questions the Check-In may not have (SUPPORT-1)', async () => {
    backend('VERIFIED', false);
    renderScreen(<HomePage />, '/home');
    const card = await screen.findByRole('region', { name: 'Check-In' });
    expect(within(card).getByText(/short questions/)).not.toHaveTextContent(
      /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten) short questions/i,
    );
  });
});
