/**
 * R16.2 (contributor's call, D-065): a path with any `%` that decodes, until stable, to an auth
 * path answers 404 before routing, so no encoding depth slips past the edge route throttle
 * (review of #366, 2026-11-25). Other paths with `%` are left alone.
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

  // Review of #366, 2026-11-25: a fourth or fifth encoding inside the prefix is still decoded, and
  // a deeply encoded non-auth path still passes.
  it.each([
    ['/api/v0/%25252561uth/challenges', true],
    ['/api/v0%2525252Fauth/challenges', true],
    ['/app%252525252Fauth/challenges', true],
    ['/api/v0/requests%2525252F1', false],
    ['/api/v0/requests/%252561', false],
  ])('decodes %s until stable, flagged=%s', (url, flagged) => {
    expect(isPercentEncodedAuthPath(url)).toBe(flagged);
  });
});
