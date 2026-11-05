import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RequestStatusCard, type RequestStatusCardProps } from './RequestStatusCard';
import type { RequestCard } from './request-card';

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

  it('FULFILLED offers "Confirm it\'s done", and CONFIRMED does not', () => {
    show({ card: 'ACCEPTED', status: 'FULFILLED', counterpartName: 'Dee R.' });
    expect(screen.getByRole('button', { name: "Confirm it's done" })).toBeInTheDocument();
  });

  it('MATCHING shows no Message button and no later-state words', () => {
    show({ card: 'MATCHING', status: 'MATCHING', cancellable: true });
    expect(screen.getByRole('status')).toHaveTextContent('Looking for a veteran');
    expect(screen.queryByRole('link', { name: 'Message' })).not.toBeInTheDocument();
    expect(screen.queryByText(/accepted/i)).not.toBeInTheDocument();
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
