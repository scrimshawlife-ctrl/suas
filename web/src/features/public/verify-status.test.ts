import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { isGateError, retryAfterText, verifyView, type VerifyResult } from './verify-status';

const standing = (
  status: string,
  reason: string | null = null,
  extra: Partial<VerifyResult> = {},
): VerifyResult => ({ status, not_confirmed_reason: reason, ...extra });
const result = (
  status: string,
  reason: string | null = null,
  extra: Partial<VerifyResult> = {},
) => ({
  result: standing(status, reason, extra),
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
    expect(verifyView(standing(status, reason), null, null)).toBe(view);
  });

  it("shows this visit's answer over an older standing", () => {
    const old = standing('NOT_CONFIRMED', 'NOT_TITLE_38');
    expect(verifyView(old, result('NOT_CONFIRMED', 'PERSON_NOT_FOUND'), null)).toBe('not_found');
    expect(verifyView(old, result('UNAVAILABLE', 'ERROR'), null)).toBe('unavailable');
    expect(verifyView(old, failed(429, 'VERIFICATION_ATTEMPT_LIMIT'), null)).toBe('limit');
    expect(verifyView(old, failed(403, 'VERIFICATION_REVOKED'), null)).toBe('revoked');
  });

  it('shows a VA 400 (REQUEST_INVALID) as correctable, never as an outage or a finding', () => {
    const invalid = result('UNAVAILABLE', null, { failure_class: 'REQUEST_INVALID' });
    expect(verifyView(undefined, invalid, null)).toBe('request_invalid');
    const outage = result('UNAVAILABLE', 'ERROR', { failure_class: 'TIMEOUT' });
    expect(verifyView(undefined, outage, null)).toBe('unavailable');
  });

  it.each([
    [503, 'ID_VERIFICATION_UNAVAILABLE', 'disabled'],
    [409, 'VA_NAME_MISMATCH', 'name_mismatch'],
    [409, 'VA_IDENTITY_ALREADY_VERIFIED', 'identity_taken'],
  ] as const)('a %s %s shows its own view, %s', (status, code, view) => {
    expect(verifyView(undefined, failed(status, code), null)).toBe(view);
    expect(isGateError(new ApiError(status, code, 'x'))).toBe(true);
  });

  it('reopens the form, or opens self-attestation, after an answer', () => {
    const limit = failed(429, 'VERIFICATION_ATTEMPT_LIMIT');
    expect(verifyView(standing('NOT_CONFIRMED', 'NOT_TITLE_38'), null, 'form')).toBe('start');
    expect(verifyView(undefined, limit, 'self_attest')).toBe('self_attest');
    // A revocation ends the self-attestation step too.
    expect(verifyView(undefined, failed(403, 'VERIFICATION_REVOKED'), 'self_attest')).toBe(
      'revoked',
    );
  });

  it('lets a VERIFIED or REVOKED standing win, and names how it was confirmed', () => {
    expect(verifyView(standing('REVOKED'), result('VERIFIED'), 'form')).toBe('revoked');
    expect(verifyView(standing('VERIFIED'), result('NOT_CONFIRMED', 'NOT_TITLE_38'), null)).toBe(
      'verified',
    );
    const attested = standing('VERIFIED', null, { method: 'SELF_ATTESTATION' });
    expect(verifyView(attested, null, 'self_attest')).toBe('attested');
  });

  it('leaves an idempotency conflict or a bad field on the form', () => {
    expect(isGateError(new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'x'))).toBe(false);
    expect(isGateError(new ApiError(400, 'VALIDATION_FAILED', 'x'))).toBe(false);
    expect(isGateError(new Error('offline'))).toBe(false);
  });
});

describe('retryAfterText', () => {
  const now = new Date(2026, 10, 10, 9, 0, 0);

  it('names a time later the same day, tomorrow or on a date, never "today"', () => {
    expect(retryAfterText(2 * 3600, now)).toMatch(/^You can try VA again after 11:00\sAM\.$/);
    expect(retryAfterText(20 * 3600 + 30, now)).toMatch(
      /^You can try VA again after 5:01\sAM tomorrow\.$/,
    );
    expect(retryAfterText(48 * 3600, now)).toMatch(
      /^You can try VA again after 9:00\sAM on Thursday, November 12\.$/,
    );
  });

  it('falls back to "later" without a Retry-After', () => {
    expect(retryAfterText(null, now)).toBe('You can try VA again later.');
  });
});
