import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import {
  checkChip,
  fingerprintText,
  identityMatchText,
  licenceCommandError,
  licenceLoadError,
  sentAgo,
} from './licence-labels';

describe('licence review labels', () => {
  it('shows the identity match result only, with null as not read', () => {
    expect(identityMatchText('YES')).toBe('Matches the details given to VA: yes');
    expect(identityMatchText('NO')).toBe('Matches the details given to VA: no');
    expect(identityMatchText('UNKNOWN')).toBe('Matches the details given to VA: not read');
    expect(identityMatchText(null)).toBe('Matches the details given to VA: not read');
  });

  it('a null fingerprint says the duplicate check is not possible', () => {
    expect(fingerprintText(null)).toMatch(/not read/);
    expect(fingerprintText(true)).toMatch(/already on an approved review/);
  });

  it('consistency checks read pass, fail or not run', () => {
    expect(checkChip('pass').text).toBe('Pass');
    expect(checkChip('fail').text).toBe('Fail');
    expect(checkChip('not_run').text).toBe('Not run');
  });

  it('the queue says how old a review is, never a name', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    expect(sentAgo('2026-11-11T09:00:00Z', now)).toBe('Sent 3 hours ago');
    expect(sentAgo('2026-11-09T12:00:00Z', now)).toBe('Sent 2 days ago');
  });
});

describe('licenceCommandError', () => {
  it('explains the second-admin rule and the approval refusals in plain words', () => {
    expect(licenceCommandError(new ApiError(403, 'SECOND_REVIEWER_REQUIRED', 'x'))).toMatch(
      /a different admin must confirm it/,
    );
    expect(licenceCommandError(new ApiError(409, 'LICENCE_IDENTITY_MISMATCH', 'x'))).toMatch(
      /does not match the details given to VA/,
    );
    expect(licenceCommandError(new ApiError(500, 'INTERNAL', 'secret detail'))).not.toMatch(
      /secret/,
    );
  });

  it('names the self-review and recusal refusals when a review cannot be opened', () => {
    expect(licenceLoadError(new ApiError(403, 'SELF_REVIEW_FORBIDDEN', 'x'))).toMatch(
      /your own account/,
    );
    expect(licenceLoadError(new ApiError(403, 'REVIEWER_RECUSED', 'x'))).toMatch(/stepped back/);
    expect(licenceLoadError(new ApiError(403, 'FORBIDDEN', 'x'))).toBeNull();
  });
});
