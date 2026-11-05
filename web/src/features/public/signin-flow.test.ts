import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/errors';
import {
  afterSignInPath,
  cleanCode,
  parseRole,
  roleToMode,
  safeFrom,
  signInErrorMessage,
  validateCode,
  validateEmail,
} from './signin-flow';

describe('code input', () => {
  it('keeps digits only, at most six, so a pasted code works', () => {
    expect(cleanCode('123 456')).toBe('123456');
    expect(cleanCode('12-34-56-78')).toBe('123456');
    expect(cleanCode('ab12')).toBe('12');
  });

  it('asks for all 6 digits', () => {
    expect(validateCode('12345')).toBe('Enter all 6 digits.');
    expect(validateCode('')).toBe('Enter all 6 digits.');
    expect(validateCode('123456')).toBeNull();
  });
});

describe('email', () => {
  it('rejects empty and malformed addresses', () => {
    expect(validateEmail('  ')).toBe('Enter your email address.');
    expect(validateEmail('marcus@')).toBe('Enter a valid email address.');
    expect(validateEmail(' marcus@example.invalid ')).toBeNull();
  });
});

describe('where to go after sign-in', () => {
  it('prefers the page the person was heading to', () => {
    expect(afterSignInPath('/requests/abc?x=1', 'serve')).toBe('/requests/abc?x=1');
  });

  it('falls back to the home of the chosen mode', () => {
    expect(afterSignInPath(undefined, 'support')).toBe('/home');
    expect(afterSignInPath(undefined, 'serve')).toBe('/serve');
  });

  it('ignores a from that leaves the app', () => {
    expect(safeFrom('//evil.test')).toBeNull();
    expect(safeFrom('https://evil.test')).toBeNull();
    expect(safeFrom('/\\evil.test')).toBeNull();
    expect(safeFrom('/ok\\path')).toBeNull();
    expect(safeFrom('/ok\npath')).toBeNull();
    expect(safeFrom('/ok\u007f')).toBeNull();
    expect(afterSignInPath('//evil.test', 'support')).toBe('/home');
  });

  it('maps the role to a mode, defaulting a bad ?role', () => {
    expect(roleToMode('serve')).toBe('serve');
    expect(roleToMode('need')).toBe('support');
    expect(parseRole('serve', 'need')).toBe('serve');
    expect(parseRole('admin', 'need')).toBe('need');
    expect(parseRole(null, 'serve')).toBe('serve');
  });
});

describe('sign-in errors in plain words', () => {
  it('uses the retry time on a 429 when the server sent one', () => {
    const limited = new ApiError(429, 'RATE_LIMITED', 'x', 300);
    expect(signInErrorMessage(limited)).toBe('Too many tries. Try again in 5 minutes.');
    expect(signInErrorMessage(new ApiError(429, 'RATE_LIMITED', 'x', 30))).toBe(
      'Too many tries. Try again in 30 seconds.',
    );
    expect(signInErrorMessage(new ApiError(429, 'RATE_LIMITED', 'x', 1))).toBe(
      'Too many tries. Try again in 1 second.',
    );
    expect(signInErrorMessage(new ApiError(429, 'RATE_LIMITED', 'x', 60))).toBe(
      'Too many tries. Try again in 1 minute.',
    );
  });

  it('still reads plainly on a 429 without retry-after', () => {
    expect(signInErrorMessage(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe(
      'Too many tries. Wait a little and try again.',
    );
  });

  it('shows the API message for a wrong or expired code', () => {
    expect(signInErrorMessage(new ApiError(401, 'INVALID_CODE', 'That code is not right.'))).toBe(
      'That code is not right.',
    );
  });

  it('does not leak a network failure', () => {
    expect(signInErrorMessage(new TypeError('Failed to fetch'))).toMatch(/could not reach SUAS/);
  });
});
