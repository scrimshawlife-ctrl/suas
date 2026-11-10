import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { isGateError, retryAfterText, verifyView, type VerifyResult } from './verify-status';

const standing = (status: string, reason: string | null = null): VerifyResult => ({
  status,
  not_confirmed_reason: reason,
});
const result = (status: string, reason: string | null = null) => ({
  result: standing(status, reason),
});
const failed = (status: number, code: string) => ({ error: new ApiError(status, code, 'x') });

describe('verifyView', () => {
  it.each([
    ['NOT_STARTED', null, 'start'],
    ['PENDING', null, 'start'],
    ['UNAVAILABLE', 'ERROR', 'start'],
    ['VERIFIED', null, 'verified'],
    ['REVOKED', null, 'revoked'],
    ['NOT_CONFIRMED', 'PERSON_NOT_FOUND', 'not_found'],
    ['NOT_CONFIRMED', 'NOT_TITLE_38', 'not_confirmed'],
    ['NOT_CONFIRMED', 'MORE_RESEARCH_REQUIRED', 'not_confirmed'],
  ] as const)('a stored %s / %s standing shows %s', (status, reason, view) => {
    expect(verifyView(standing(status, reason), null, false)).toBe(view);
  });

  it("shows this visit's answer over an older standing", () => {
    const old = standing('NOT_CONFIRMED', 'NOT_TITLE_38');
    expect(verifyView(old, result('NOT_CONFIRMED', 'PERSON_NOT_FOUND'), true)).toBe('not_found');
    expect(verifyView(old, result('UNAVAILABLE', 'ERROR'), true)).toBe('unavailable');
    expect(verifyView(old, failed(429, 'VERIFICATION_ATTEMPT_LIMIT'), true)).toBe('limit');
    expect(verifyView(old, failed(503, 'ID_VERIFICATION_UNAVAILABLE'), true)).toBe('unavailable');
    expect(verifyView(old, failed(403, 'VERIFICATION_REVOKED'), true)).toBe('revoked');
  });

  it('reopens the form after a not-confirmed answer', () => {
    expect(verifyView(standing('NOT_CONFIRMED', 'NOT_TITLE_38'), null, true)).toBe('start');
  });

  it('lets a VERIFIED or REVOKED standing win', () => {
    expect(verifyView(standing('REVOKED'), result('VERIFIED'), true)).toBe('revoked');
    expect(verifyView(standing('VERIFIED'), result('NOT_CONFIRMED', 'NOT_TITLE_38'), false)).toBe(
      'verified',
    );
  });

  it('treats only 403, 429 and 503 gate codes as their own views', () => {
    expect(isGateError(new ApiError(429, 'VERIFICATION_ATTEMPT_LIMIT', 'x'))).toBe(true);
    expect(isGateError(new ApiError(400, 'VALIDATION_FAILED', 'x'))).toBe(false);
    expect(isGateError(new Error('offline'))).toBe(false);
  });
});

describe('retryAfterText', () => {
  const now = new Date(2026, 10, 10, 9, 0, 0);

  it('names a time later today or tomorrow', () => {
    expect(retryAfterText(2 * 3600, now)).toMatch(/^Try again after 11:00\sAM today\.$/);
    expect(retryAfterText(20 * 3600 + 30, now)).toMatch(/^Try again after 5:01\sAM tomorrow\.$/);
  });

  it('falls back to "later" without a Retry-After', () => {
    expect(retryAfterText(null, now)).toBe('Try again later.');
  });
});
