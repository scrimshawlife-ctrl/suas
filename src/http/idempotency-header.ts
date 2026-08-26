/**
 * Shared Idempotency-Key header parsing for consequential `/api/v0` commands.
 *
 * Spec: SUAS-specs API.md §7.
 */

export class MissingIdempotencyKeyError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor() {
    super('Idempotency-Key header is required for this command (SUAS-specs API.md §7).');
    this.name = 'MissingIdempotencyKeyError';
  }
}

export function readIdempotencyKey(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MissingIdempotencyKeyError();
  }
  return value.trim();
}
