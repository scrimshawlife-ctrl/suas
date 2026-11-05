import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '../test-utils';
import { ActiveRequest } from './ActiveRequest';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../api/client', () => ({ api: { GET: get } }));

const ID = '11111111-1111-4111-8111-111111111111';

function detail(status: string) {
  return {
    service_request_id: ID,
    case_id: ID,
    category: 'PEER_SUPPORT',
    status,
    summary: null,
    timing: null,
    meeting_place: null,
    created_at: '2026-11-04T19:42:00.000Z',
    widened: false,
    county: 'SANTA_CLARA',
    counterpart_display_name: 'Dee R.',
  };
}

beforeEach(() => {
  get.mockReset();
});

describe('ActiveRequest', () => {
  it('offers no cancel when the request read says it is fulfilled, even if active_qrf is stale', async () => {
    get.mockResolvedValue({ data: detail('FULFILLED') });
    renderScreen(
      <ActiveRequest
        active={{
          service_request_id: ID,
          state: 'RESPONDER_ACCEPTED',
          headline: 'Someone accepted your request.',
          cancellable: true,
        }}
      />,
    );
    expect(await screen.findByRole('button', { name: "Confirm it's done" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel request' })).not.toBeInTheDocument();
  });

  it('shows the matching track from active_qrf and a cancel while the read is still open', async () => {
    get.mockResolvedValue({ data: detail('MATCHING') });
    renderScreen(
      <ActiveRequest
        active={{ service_request_id: ID, state: 'SEARCHING', headline: 'x', cancellable: true }}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Request progress' })).toBeInTheDocument();
  });
});
