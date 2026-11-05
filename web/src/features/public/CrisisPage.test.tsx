import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { tokenStore } from '../../api/token-store';
import { setMode } from '../../app/mode-store';
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

/**
 * Pins every result sentence to the exact text on the Crisis and Home boards (D-012 copy).
 * A change here is a change to crisis wording and needs the same sign-off as the boards.
 */
const BOARD_SENTENCES = {
  immediate:
    'If you are in immediate danger, have a medical emergency, or believe someone may be seriously harmed, call 911 or go to the nearest emergency department.',
  threat: 'If you believe there may be an immediate threat to life or safety, call 911.',
  call988:
    'For suicidal thoughts, emotional distress, or a mental health crisis, call or text 988.',
  noDanger:
    'If there is no immediate danger, SUAS can help identify the practical support you need.',
  notEmergencyService:
    'SUAS coordinates practical support. It is not an emergency service and cannot replace police, fire, EMS, or emergency medical care.',
  serious: 'The situation is serious, but there is no immediate threat to life or safety.',
};

describe('crisis result copy', () => {
  it.each([
    [
      'yes',
      'Yes, immediate danger',
      [BOARD_SENTENCES.immediate, BOARD_SENTENCES.call988, BOARD_SENTENCES.notEmergencyService],
      ['call911', 'call988'],
    ],
    [
      'no',
      'No, urgent support needed',
      [
        BOARD_SENTENCES.serious,
        BOARD_SENTENCES.threat,
        BOARD_SENTENCES.call988,
        BOARD_SENTENCES.noDanger,
      ],
      ['call911', 'call988', 'continue'],
    ],
    [
      'unsure',
      'If you are unsure, treat immediate safety first.',
      [BOARD_SENTENCES.threat, BOARD_SENTENCES.call988, BOARD_SENTENCES.noDanger],
      ['call911', 'call988', 'continue'],
    ],
  ] as const)('%s uses exactly the board wording', (answer, heading, paragraphs, buttons) => {
    expect(crisisResult(answer)).toEqual({
      heading,
      paragraphs: [...paragraphs],
      buttons: [...buttons],
    });
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

  describe('Request practical support', () => {
    beforeEach(() => {
      tokenStore.clear();
      setMode('support');
    });

    it('goes to sign in as a person who needs support when signed out', () => {
      renderPage();
      expect(screen.getByRole('link', { name: 'Request practical support' })).toHaveAttribute(
        'href',
        '/sign-in?role=need',
      );
    });

    it('goes to /home when signed in, even in Serve mode', () => {
      tokenStore.setToken('tok');
      setMode('serve');
      renderPage();
      expect(screen.getByRole('link', { name: 'Request practical support' })).toHaveAttribute(
        'href',
        '/home',
      );
      expect(screen.getByRole('link', { name: 'Continue with SUAS support' })).toHaveAttribute(
        'href',
        '/serve',
      );
    });
  });
});
