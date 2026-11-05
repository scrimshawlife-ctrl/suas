import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import { verifyStep, verifyView } from './verify-status';

describe('verify status mapping', () => {
  it.each([
    ['NOT_STARTED', 'start'],
    [undefined, 'start'],
    ['PENDING', 'pending'],
    ['VERIFIED', 'verified'],
    ['NOT_CONFIRMED', 'not_confirmed'],
    ['UNAVAILABLE', 'unavailable'],
    ['REVOKED', 'revoked'],
  ] as const)('%s shows %s', (status, view) => {
    expect(verifyView(status)).toBe(view);
  });

  it('shows unavailable when start answers 503 ID_VERIFICATION_UNAVAILABLE', () => {
    const error = new ApiError(503, 'ID_VERIFICATION_UNAVAILABLE', 'not available');
    expect(verifyView('NOT_STARTED', error)).toBe('unavailable');
  });

  it('keeps the status view on any other start failure', () => {
    expect(verifyView('NOT_STARTED', new ApiError(500, 'INTERNAL', 'x'))).toBe('start');
  });

  it('puts the stepper on step 3 only when verified', () => {
    expect(verifyStep('start')).toBe(0);
    expect(verifyStep('pending')).toBe(1);
    expect(verifyStep('verified')).toBe(2);
    expect(verifyStep('unavailable')).toBe(0);
  });
});
