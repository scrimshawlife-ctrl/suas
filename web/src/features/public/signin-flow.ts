import { isApiError } from '../../api/errors';
import type { Mode } from '../../components/ModeSwitch';

/** The two sign-in roles on the Sign in screen. `need` maps to the Need support mode. */
export type Role = 'need' | 'serve';

export function parseRole(value: string | null, fallback: Role): Role {
  return value === 'need' || value === 'serve' ? value : fallback;
}

export function roleToMode(role: Role): Mode {
  return role === 'serve' ? 'serve' : 'support';
}

export function modeToRole(mode: Mode): Role {
  return mode === 'serve' ? 'serve' : 'need';
}

export function homePathForMode(mode: Mode): string {
  return mode === 'serve' ? '/serve' : '/home';
}

/** Only same-origin paths are followed: "/x" yes, "//evil.test" and "https://…" no. */
export function safeFrom(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    ? value
    : null;
}

/** Where to go once signed in: the page the person was heading to, else their mode's home. */
export function afterSignInPath(from: unknown, mode: Mode): string {
  return safeFrom(from) ?? homePathForMode(mode);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns a plain-words error, or null when the email can be sent a code. */
export function validateEmail(value: string): string | null {
  const email = value.trim();
  if (email.length === 0) return 'Enter your email address.';
  if (email.length > 320 || !EMAIL.test(email)) return 'Enter a valid email address.';
  return null;
}

/** Keeps digits only and at most six, so a pasted "123 456" or "123-456" works. */
export function cleanCode(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}

export function validateCode(code: string): string | null {
  return /^\d{6}$/.test(code) ? null : 'Enter all 6 digits.';
}

function waitPhrase(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Plain-words message for a failed sign-in step. Never a stack, never a bare status. */
export function signInErrorMessage(error: unknown): string {
  if (!isApiError(error)) return 'We could not reach SUAS. Check your connection and try again.';
  if (error.status === 429) {
    const wait = error.retryAfterSeconds;
    return wait === null
      ? 'Too many tries. Wait a little and try again.'
      : `Too many tries. Try again in ${waitPhrase(wait)}.`;
  }
  if (error.status >= 500) return 'Sign-in is not available right now. Try again in a few minutes.';
  return error.message;
}
