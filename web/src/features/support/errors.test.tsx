import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { ErrorNotice, errorSentence, gateTarget } from './errors';

function renderAt(error: unknown) {
  render(
    <MemoryRouter initialEntries={['/here']}>
      <Routes>
        <Route path="/here" element={<ErrorNotice error={error} doing="load things" />} />
        <Route path="/verify" element={<p>verify page</p>} />
        <Route path="/welcome" element={<p>welcome page</p>} />
        <Route path="/admin/mfa" element={<p>mfa page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ErrorNotice', () => {
  it('sends gate errors to their screen instead of showing text', () => {
    renderAt(new ApiError(403, 'VERIFICATION_REQUIRED', 'x'));
    expect(screen.getByText('verify page')).toBeInTheDocument();
  });

  it('sends a missing county to /welcome and a missing MFA step-up to /admin/mfa', () => {
    expect(gateTarget(new ApiError(422, 'COUNTY_REQUIRED', 'x'))).toBe('/welcome');
    expect(gateTarget(new ApiError(403, 'MFA_REQUIRED', 'x'))).toBe('/admin/mfa');
    expect(gateTarget(new ApiError(403, 'FORBIDDEN', 'x'))).toBeNull();
    expect(gateTarget(new Error('x'))).toBeNull();
  });

  it('shows a plain sentence, never the server message', () => {
    renderAt(new ApiError(500, 'INTERNAL', 'stack trace here'));
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong on our side. Try to load things again.',
    );
    expect(screen.queryByText(/stack trace/)).toBeNull();
    expect(errorSentence(new Error('offline'), 'load things')).toBe(
      'We could not load things. Check your connection and try again.',
    );
  });

  // G3, G4: only a dropped connection or a timeout asks to check the connection.
  it.each([
    [
      new TypeError('Failed to fetch'),
      'We could not load things. Check your connection and try again.',
    ],
    [
      new ApiError(408, 'TIMEOUT', 'x'),
      'We could not load things. Check your connection and try again.',
    ],
    [
      new ApiError(413, 'PAYLOAD_TOO_LARGE', 'x'),
      'We could not load things. What you entered is too long.',
    ],
    [
      new ApiError(400, 'VALIDATION_FAILED', 'x'),
      'We could not load things. Some of what you entered needs another look.',
    ],
    [
      new ApiError(422, 'VALIDATION_FAILED', 'x'),
      'We could not load things. Some of what you entered needs another look.',
    ],
    [
      new ApiError(403, 'FORBIDDEN', 'x'),
      'We could not load things. You do not have access to that.',
    ],
    [new ApiError(404, 'NOT_FOUND', 'x'), 'That is no longer available.'],
    [
      new ApiError(409, 'CONFLICT', 'x'),
      'We could not load things. This changed while you were looking. Reload the page.',
    ],
    [new ApiError(410, 'GONE', 'x'), 'We could not load things. Try again.'],
  ])('words %s by its status', (error, sentence) => {
    expect(errorSentence(error, 'load things')).toBe(sentence);
  });
});
