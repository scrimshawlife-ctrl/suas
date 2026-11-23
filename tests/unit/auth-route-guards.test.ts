/**
 * R16.2 (contributor's call, D-065): any `%` in an auth path answers 404 before routing, whatever
 * is encoded and however often, so no variant can slip past the edge route throttle.
 */

import { describe, expect, it } from 'vitest';
import { isPercentEncodedAuthPath } from '../../src/http/auth-route-guards.js';

describe('isPercentEncodedAuthPath', () => {
  it.each([
    '/api/v0/auth/%63hallenges',
    '/api/v0/auth%2Fchallenges',
    '/api/v0/auth%2fchallenges',
    '/api/v0/auth/challenges%23',
    '/api/v0/auth/%2563hallenges',
    '/api/v0/auth/%25252563hallenges',
    '/api/v0/%41UTH/challenges',
    '/api/v0/auth/challenges%zz',
    '/app/auth%2Fchallenges',
  ])('flags %s', (url) => {
    expect(isPercentEncodedAuthPath(url)).toBe(true);
  });

  it.each([
    '/api/v0/auth/challenges',
    '/api/v0/auth/challenges?next=%2Fhome',
    '/api/v0/cases/%63urrent',
    '/app/home%2F',
  ])('leaves %s alone', (url) => {
    expect(isPercentEncodedAuthPath(url)).toBe(false);
  });

  // R16.2 (contributor's call, D-065): a malformed escape is never decoded, so any `%` under the
  // auth prefix is flagged and one elsewhere is not.
  it.each([
    ['/api/v0/auth/%GGhallenges', true],
    ['/api/v0/auth/challenges%2', true],
    ['/api/v0/auth/%', true],
    ['/api/v0/items/%GG', false],
  ])('treats the malformed escape in %s as flagged=%s', (url, flagged) => {
    expect(isPercentEncodedAuthPath(url)).toBe(flagged);
  });
});
