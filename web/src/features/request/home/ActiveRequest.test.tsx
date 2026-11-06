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
          category: 'PEER_SUPPORT',
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
        active={{
          service_request_id: ID,
          category: 'PEER_SUPPORT',
          state: 'SEARCHING',
          headline: 'x',
          cancellable: true,
        }}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Request progress' })).toBeInTheDocument();
  });

  it('keeps the QRF title for peer support and names any other category', async () => {
    const active = (category: 'PEER_SUPPORT' | 'FOOD' | 'TRANSPORTATION' | 'SHELTER') => ({
      service_request_id: ID,
      category,
      state: 'REQUESTED',
      headline: 'x',
      cancellable: true,
    });
    get.mockResolvedValue({ data: detail('SUBMITTED') });
    const peer = renderScreen(<ActiveRequest active={active('PEER_SUPPORT')} />);
    expect(await screen.findByRole('heading', { name: 'Your QRF request' })).toBeInTheDocument();
    peer.unmount();

    const titles = {
      FOOD: 'Your food request',
      TRANSPORTATION: 'Your transportation request',
      SHELTER: 'Your housing request',
    } as const;
    for (const [category, title] of Object.entries(titles)) {
      const view = renderScreen(<ActiveRequest active={active(category as keyof typeof titles)} />);
      expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
      view.unmount();
    }
  });
});
