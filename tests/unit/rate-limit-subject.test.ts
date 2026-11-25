import { describe, expect, it } from 'vitest';
import { rateLimitSubjectKey } from '../../src/auth/rate-limit.js';

// Review 2026-11-24 (#369): the stored key is a fixed-length hash that names no address.
describe('rateLimitSubjectKey', () => {
  it('is a stable sha256 key with no trace of the subject', () => {
    const key = rateLimitSubjectKey('a.b+tag@example.invalid');
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(key).toBe(rateLimitSubjectKey('a.b+tag@example.invalid'));
    expect(key).not.toContain('example');
  });

  it('keeps different subjects apart', () => {
    expect(rateLimitSubjectKey('a@example.invalid')).not.toBe(
      rateLimitSubjectKey('b@example.invalid'),
    );
    expect(rateLimitSubjectKey('+15555550100')).not.toBe(rateLimitSubjectKey('+15555550101'));
  });
});
