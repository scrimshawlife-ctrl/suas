import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { requestErrorMessage } from './errors';

// G3, G4: each status gets its own sentence; only a dropped connection or a timeout asks
// the person to check their connection.
describe('requestErrorMessage', () => {
  const connection = 'That did not go through. Check your connection and try again.';

  it.each([
    [new TypeError('Failed to fetch'), connection],
    [new ApiError(408, 'TIMEOUT', 'x'), connection],
    [
      new ApiError(413, 'PAYLOAD_TOO_LARGE', 'x'),
      'What you entered is too long. Shorten it and try again.',
    ],
    [new ApiError(400, 'VALIDATION_FAILED', 'x'), 'Some of what you entered needs another look.'],
    [new ApiError(422, 'VALIDATION_FAILED', 'x'), 'Some of what you entered needs another look.'],
    [new ApiError(403, 'FORBIDDEN', 'x'), 'Only the person who asked for help can do that.'],
    [new ApiError(403, 'NOT_ALLOWED', 'x'), 'You do not have access to that.'],
    [new ApiError(404, 'NOT_FOUND', 'x'), 'We could not find that request.'],
    [
      new ApiError(409, 'STALE_STATE', 'x'),
      'This changed while you were looking. Reload the page to see where it stands.',
    ],
    [new ApiError(429, 'RATE_LIMITED', 'x'), 'Too many tries. Wait a moment and try again.'],
    [new ApiError(500, 'INTERNAL', 'x'), 'Something went wrong on our side. Try again.'],
    [new ApiError(410, 'GONE', 'x'), 'That did not go through. Try again.'],
  ])('words %s by its status', (error, message) => {
    expect(requestErrorMessage(error)).toBe(message);
  });
});
