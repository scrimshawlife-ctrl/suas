import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RequestStatusCard, type RequestStatusCardProps } from './RequestStatusCard';
import type { RequestCard } from './request-card';

const CARDS: RequestCard[] = [
  'RECEIVED',
  'MATCHING',
  'NOTIFIED',
  'ACCEPTED',
  'UNAVAILABLE',
  'DEGRADED',
  'CANCELLED',
];

function show(props: Partial<RequestStatusCardProps> & { card: RequestCard }) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <RequestStatusCard
          variant="detail"
          requestId="11111111-1111-4111-8111-111111111111"
          cancellable={false}
          {...props}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequestStatusCard', () => {
  it('ACCEPTED names the person, offers Message and never Call', () => {
    show({ card: 'ACCEPTED', status: 'ACCEPTED', counterpartName: 'Dee R.', cancellable: true });
    expect(
      screen.getByRole('heading', { name: 'Dee R. accepted your request.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Message' })).toHaveAttribute(
      'href',
      '/chat/11111111-1111-4111-8111-111111111111',
    );
    expect(screen.queryByText('Call')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel request' })).toBeInTheDocument();
  });

  it('offers "Confirm it\'s done" for FULFILLED only', () => {
    show({ card: 'ACCEPTED', status: 'FULFILLED', counterpartName: 'Dee R.' });
    expect(screen.getByRole('button', { name: "Confirm it's done" })).toBeInTheDocument();
  });

  it.each(['ACCEPTED', 'IN_PROGRESS', 'CONFIRMED', 'CLOSED'] as const)(
    'hides Confirm for %s',
    (status) => {
      show({ card: 'ACCEPTED', status, counterpartName: 'Dee R.' });
      expect(screen.queryByRole('button', { name: "Confirm it's done" })).not.toBeInTheDocument();
    },
  );

  it.each(CARDS)('%s has a role=status chip', (card) => {
    show({ card });
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows no progress track on the accepted card, and one on the matching card at home', () => {
    show({ variant: 'home', card: 'ACCEPTED', status: 'ACCEPTED' });
    expect(screen.queryByRole('list', { name: 'Request progress' })).not.toBeInTheDocument();
    cleanup();
    show({ variant: 'home', card: 'MATCHING', status: 'MATCHING' });
    expect(screen.getByRole('list', { name: 'Request progress' })).toBeInTheDocument();
  });

  it('MATCHING shows no Message button and no later-state words', () => {
    show({ card: 'MATCHING', status: 'MATCHING', cancellable: true });
    expect(screen.getByRole('status')).toHaveTextContent('Looking for a veteran');
    expect(screen.queryByRole('link', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByText(/accepted/i)).not.toBeInTheDocument();
  });

  it('names the crisis links and includes text 988', () => {
    show({ card: 'UNAVAILABLE' });
    const call911 = screen.getByRole('link', { name: 'Call 911' });
    const call988 = screen.getByRole('link', { name: 'Call 988' });
    const text988 = screen.getByRole('link', { name: 'Text 988' });
    expect(call911).toHaveAttribute('href', 'tel:911');
    expect(call988).toHaveAttribute('href', 'tel:988');
    expect(text988).toHaveAttribute('href', 'sms:988');
    for (const link of [call911, call988, text988]) {
      expect(link).toHaveClass('inline-flex', 'min-h-11', 'min-w-11');
    }
    expect(screen.getByText(/life-threatening/)).toHaveTextContent(
      /call 911\s*\.\s*For a suicide or emotional crisis, call or text 988/,
    );
  });

  it('UNAVAILABLE offers another category and no new request', () => {
    show({ card: 'UNAVAILABLE' });
    expect(screen.getByRole('link', { name: 'Try another support category' })).toHaveAttribute(
      'href',
      '/home',
    );
    expect(screen.queryByRole('link', { name: 'Start a new request' })).not.toBeInTheDocument();
  });

  it('CANCELLED offers a new request and no cancel', () => {
    show({ card: 'CANCELLED', status: 'CANCELLED' });
    expect(screen.getByRole('link', { name: 'Start a new request' })).toHaveAttribute(
      'href',
      '/request',
    );
    expect(screen.queryByRole('button', { name: 'Cancel request' })).not.toBeInTheDocument();
  });
});
