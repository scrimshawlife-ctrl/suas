import { describe, expect, it } from 'vitest';
import { SessionSecretMissingError } from '../../src/auth/secrets.js';
import { rateLimitSubject } from '../../src/auth/rate-limit.js';

const SECRET = 'test-secret-0123456789abcdef0123456789';
const RAW = 'vector@example.invalid';

// Review of #374, 2026-11-25: the stored subject is a versioned, bucket-scoped keyed HMAC. The
// expected hex was computed outside the code under test, with openssl:
//   K=$(printf 'suas.rate-limit.v1' | openssl dgst -sha256 -hmac 'test-secret-0123456789abcdef0123456789' -binary | xxd -p -c 256)
//   printf 'auth.challenge.issue\0vector@example.invalid' | openssl dgst -sha256 -mac HMAC -macopt hexkey:$K
describe('rateLimitSubject', () => {
  it('matches the independently computed HMAC vector', () => {
    expect(rateLimitSubject(SECRET, 'auth.challenge.issue', RAW).key).toBe(
      'hmac1:f40adad56990d5eb938f08f657f517759b771c7e5f28deb2946fba1ce1653d7f',
    );
  });

  it('scopes the key to its bucket and keeps the raw subject out of it', () => {
    const issue = rateLimitSubject(SECRET, 'auth.challenge.issue', RAW);
    const verify = rateLimitSubject(SECRET, 'auth.challenge.verify', RAW);
    expect(verify.key).not.toBe(issue.key);
    expect(issue.key).not.toContain('vector');
    expect(issue.key).not.toContain('example');
    expect(issue.legacy).toBe(RAW);
  });

  it('refuses to key a subject without a secret', () => {
    expect(() => rateLimitSubject('', 'auth.challenge.issue', RAW)).toThrow(
      SessionSecretMissingError,
    );
  });
});
