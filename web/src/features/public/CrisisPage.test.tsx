import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { crisisResult } from './crisis-result';
import CrisisPage from './CrisisPage';

function renderPage() {
  const router = createMemoryRouter([{ path: '/crisis', element: <CrisisPage /> }], {
    initialEntries: ['/crisis'],
  });
  render(<RouterProvider router={router} />);
}

describe('crisis result per answer', () => {
  it('always offers 911 and 988, and never 911 alone', () => {
    for (const answer of ['yes', 'no', 'unsure'] as const) {
      const { buttons } = crisisResult(answer);
      expect(buttons).toContain('call911');
      expect(buttons).toContain('call988');
    }
  });

  it('leaves "Continue with SUAS" out of the immediate danger answer', () => {
    expect(crisisResult('yes').buttons).not.toContain('continue');
    expect(crisisResult('no').buttons).toContain('continue');
  });
});

describe('Crisis page', () => {
  it('opens on the "Not sure" result as drawn and shows the right column', () => {
    renderPage();
    expect(screen.getByRole('radio', { name: /Not sure/ })).toBeChecked();
    expect(
      screen.getByRole('heading', { name: 'If you are unsure, treat immediate safety first.' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Need help right now?' })).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'You do not have to handle this alone.' }),
    ).toBeInTheDocument();
  });

  it('shows a result for "Yes, immediate danger" with no routine buttons', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: /Yes, immediate danger/ }));
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('call 911 or go to the nearest emergency department');
    expect(status).not.toHaveTextContent('Continue with SUAS');
    expect(status.querySelectorAll('a[href="tel:911"], a[href="tel:988"]')).toHaveLength(2);
  });

  it('shows a result for "No, urgent support needed"', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: /No, urgent support needed/ }));
    expect(screen.getByRole('status')).toHaveTextContent(
      'there is no immediate threat to life or safety',
    );
  });

  it('keeps the answer out of storage', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('radio', { name: /Yes, immediate danger/ }));
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
  });
});
