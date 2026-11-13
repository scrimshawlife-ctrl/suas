import { describe, expect, it } from 'vitest';
import {
  declineReasonText,
  licencePollInterval,
  licenceView,
  type LicenceReviewState,
  type LicenceViewInput,
} from './licence-status';

const review = (
  status: LicenceReviewState['status'],
  over: Partial<LicenceReviewState> = {},
): LicenceReviewState => ({
  review_id: 'r1',
  status,
  decline_reason: null,
  failure_class: null,
  ...over,
});

const input = (over: Partial<LicenceViewInput> = {}): LicenceViewInput => ({
  standing: { status: 'NOT_CONFIRMED', method: 'VA_VETERAN_STATUS' },
  offered: true,
  review: null,
  refused: null,
  replacing: null,
  ...over,
});

describe('licenceView', () => {
  it.each([
    [null, 'form'],
    [review('READING'), 'reading'],
    [review('AWAITING_REVIEW'), 'awaiting'],
    [review('AWAITING_CONFIRMATION'), 'awaiting'],
    [review('DECLINED', { decline_reason: 'EXPIRED' }), 'declined'],
    [review('APPROVED'), 'approved'],
    [review('REVOKED'), 'withdrawn'],
  ] as const)('an offered person with review %o sees %s', (current, view) => {
    expect(licenceView(input({ review: current }))).toBe(view);
  });

  it.each([
    ['NOT_A_LICENCE', 'unreadable'],
    ['PHOTOS_EXPIRED', 'photos_lost'],
    ['PHOTOS_GONE', 'photos_lost'],
    ['NOT_SYNTHETIC', 'not_synthetic'],
    ['TIMEOUT', 'reader_down'],
    ['PROVIDER_RESPONSE_INVALID', 'reader_down'],
    [null, 'reader_down'],
  ] as const)('UNREADABLE with failure class %s shows %s', (failure_class, view) => {
    expect(licenceView(input({ review: review('UNREADABLE', { failure_class }) }))).toBe(view);
  });

  it('shows the form again once the person chooses to replace a settled review', () => {
    const declined = review('DECLINED', { decline_reason: 'ALREADY_USED' });
    expect(licenceView(input({ review: declined, replacing: 'r1' }))).toBe('form');
    expect(licenceView(input({ review: declined, replacing: 'other' }))).toBe('declined');
  });

  it('keeps an open review in view even when the path is no longer offered', () => {
    expect(licenceView(input({ offered: false, review: review('READING') }))).toBe('reading');
  });

  it('keeps a settled review in view when not offered, but never the form', () => {
    const down = review('UNREADABLE', { failure_class: 'TIMEOUT' });
    expect(licenceView(input({ offered: false, review: down }))).toBe('reader_down');
    expect(licenceView(input({ offered: false, review: down, replacing: 'r1' }))).toBe(
      'not_offered',
    );
    expect(licenceView(input({ offered: false }))).toBe('not_offered');
  });

  it('a revoked standing wins over everything, including an approval', () => {
    const standing = { status: 'REVOKED', method: 'MANUAL_REVIEW' };
    expect(licenceView(input({ standing, review: review('APPROVED') }))).toBe('revoked');
    expect(licenceView(input({ refused: 'revoked', review: review('READING') }))).toBe('revoked');
  });

  it('sends a person confirmed another way back to Verify', () => {
    const standing = { status: 'VERIFIED', method: 'SELF_ATTESTATION' };
    expect(licenceView(input({ standing, review: review('DECLINED') }))).toBe('not_offered');
  });

  it('a refused submit shows its own view', () => {
    expect(licenceView(input({ refused: 'limit' }))).toBe('limit');
    expect(licenceView(input({ refused: 'closed' }))).toBe('closed');
  });
});

describe('licencePollInterval', () => {
  it('polls fast while reading, slowly while admins have it, and stops once settled', () => {
    expect(licencePollInterval('READING')).toBe(3_500);
    expect(licencePollInterval('AWAITING_CONFIRMATION')).toBe(30_000);
    expect(licencePollInterval('DECLINED')).toBe(false);
    expect(licencePollInterval(undefined)).toBe(false);
  });
});

describe('declineReasonText', () => {
  it('reads every spec reason in plain words and falls back to OTHER', () => {
    expect(declineReasonText('SELFIE_MISMATCH')).toMatch(/selfie/);
    expect(declineReasonText('IDENTITY_MISMATCH')).toMatch(/details you gave VA/);
    expect(declineReasonText('SOMETHING_NEW')).toBe(declineReasonText('OTHER'));
    expect(declineReasonText(null)).toBe(declineReasonText('OTHER'));
  });
});
