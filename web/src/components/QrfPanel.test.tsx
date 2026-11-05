import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { QrfPanel } from './QrfPanel';

describe('QrfPanel', () => {
  it('uses the county wording on desktop and phone, and links to the request page', () => {
    render(
      <MemoryRouter>
        <QrfPanel />
      </MemoryRouter>,
    );
    expect(
      screen.getByText(
        "Veterans in your county get your request. You'll see every real update right here.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Sends a peer support request to veterans in your county.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Verified veterans/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Request peer support' })).toHaveAttribute(
      'href',
      '/request?category=PEER_SUPPORT',
    );
  });
});
