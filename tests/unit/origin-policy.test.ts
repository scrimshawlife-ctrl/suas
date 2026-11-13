/** Browser origin policy and CORS helpers (SUAS-specs D-038, released in 0.7.0). */

import { describe, expect, it } from 'vitest';
import { MAX_CORS_ALLOWED_ORIGINS, parseAllowedOrigins } from '../../src/config/cors-origins.js';
import {
  allowedRequestOrigin,
  corsFallbackHeaders,
  corsResponseHeaders,
  evaluateBrowserRequest,
  type BrowserRequestVerdict,
} from '../../src/http/origin-policy.js';

const ALLOWED = 'https://app.example.org';
const allowlist = new Set([ALLOWED, 'http://localhost:5173']);
const HOST = 'suas.example';

type Row = [
  label: string,
  secFetchSite: string | undefined,
  origin: string | undefined,
  verdict: BrowserRequestVerdict,
];

describe('evaluateBrowserRequest', () => {
  const rows: Row[] = [
    [
      'same-origin, Origin: null (browser form post under no-referrer)',
      'same-origin',
      'null',
      'allow',
    ],
    ['same-origin, same Origin', 'same-origin', `https://${HOST}`, 'allow'],
    ['same-origin, no Origin', 'same-origin', undefined, 'allow'],
    ['none (user-initiated)', 'none', undefined, 'allow'],
    ['cross-site, allowlisted', 'cross-site', ALLOWED, 'allow'],
    ['cross-site, allowlisted loopback http', 'cross-site', 'http://localhost:5173', 'allow'],
    ['same-site, allowlisted', 'same-site', ALLOWED, 'allow'],
    ['cross-site, not allowlisted', 'cross-site', 'https://attacker.example', 'deny'],
    ['same-site, not allowlisted', 'same-site', 'https://sibling.example', 'deny'],
    ['cross-site, Origin: null', 'cross-site', 'null', 'deny'],
    ['cross-site, no Origin', 'cross-site', undefined, 'deny'],
    ['cross-site, malformed Origin', 'cross-site', 'not a url', 'deny'],
    ['cross-site, non-http Origin', 'cross-site', 'file://', 'deny'],
    [
      'cross-site, allowlisted host but wrong scheme',
      'cross-site',
      'http://app.example.org',
      'deny',
    ],
    [
      'cross-site, allowlisted host but wrong port',
      'cross-site',
      'https://app.example.org:8443',
      'deny',
    ],
    [
      'unrecognised Sec-Fetch-Site is treated as cross-site',
      'bogus',
      'https://attacker.example',
      'deny',
    ],
    ['unrecognised Sec-Fetch-Site, allowlisted origin', 'bogus', ALLOWED, 'allow'],
    ['no headers at all (curl, Postman, native app)', undefined, undefined, 'allow'],
    ['no Sec-Fetch-Site, same-host Origin', undefined, `https://${HOST}`, 'allow'],
    ['no Sec-Fetch-Site, allowlisted Origin', undefined, ALLOWED, 'allow'],
    ['no Sec-Fetch-Site, foreign Origin', undefined, 'https://attacker.example', 'deny'],
    ['no Sec-Fetch-Site, Origin: null', undefined, 'null', 'deny'],
    ['no Sec-Fetch-Site, malformed Origin', undefined, 'garbage', 'deny'],
    ['Sec-Fetch-Site is case-insensitive', 'SAME-ORIGIN', 'null', 'allow'],
  ];

  it.each(rows)('%s', (_label, secFetchSite, origin, verdict) => {
    expect(
      evaluateBrowserRequest(
        { secFetchSite, origin, host: HOST, selfScheme: 'https:', cookieSession: false },
        allowlist,
      ),
    ).toBe(verdict);
  });

  it('denies every cross-site browser request when the allowlist is empty', () => {
    expect(
      evaluateBrowserRequest(
        {
          secFetchSite: 'cross-site',
          origin: ALLOWED,
          host: HOST,
          selfScheme: 'https:',
          cookieSession: false,
        },
        new Set(),
      ),
    ).toBe('deny');
  });

  it('denies a cookie-authenticated write that sends neither Sec-Fetch-Site nor Origin', () => {
    const base = { secFetchSite: undefined, origin: undefined, host: HOST, selfScheme: 'https:' };
    expect(evaluateBrowserRequest({ ...base, cookieSession: true }, allowlist)).toBe('deny');
    expect(evaluateBrowserRequest({ ...base, cookieSession: true }, new Set())).toBe('deny');
    // Bearer or unauthenticated non-browser clients stay unaffected.
    expect(evaluateBrowserRequest({ ...base, cookieSession: false }, allowlist)).toBe('allow');
  });

  it('still judges a cookie-authenticated write by its metadata when it sends any', () => {
    const cookie = { host: HOST, selfScheme: 'https:', cookieSession: true };
    expect(
      evaluateBrowserRequest({ ...cookie, secFetchSite: 'same-origin', origin: 'null' }, allowlist),
    ).toBe('allow');
    expect(
      evaluateBrowserRequest(
        { ...cookie, secFetchSite: undefined, origin: `https://${HOST}` },
        allowlist,
      ),
    ).toBe('allow');
    expect(
      evaluateBrowserRequest({ ...cookie, secFetchSite: 'cross-site', origin: ALLOWED }, allowlist),
    ).toBe('allow');
  });

  it('compares scheme as well as host in the no-Sec-Fetch-Site fallback', () => {
    const base = { secFetchSite: undefined, host: HOST, cookieSession: false };
    expect(
      evaluateBrowserRequest(
        { ...base, origin: `http://${HOST}`, selfScheme: 'https:' },
        allowlist,
      ),
    ).toBe('deny');
    expect(
      evaluateBrowserRequest(
        { ...base, origin: `https://${HOST}`, selfScheme: 'https:' },
        allowlist,
      ),
    ).toBe('allow');
    expect(
      evaluateBrowserRequest(
        { ...base, origin: `https://${HOST}`, selfScheme: 'http:' },
        allowlist,
      ),
    ).toBe('deny');
    expect(
      evaluateBrowserRequest({ ...base, origin: `http://${HOST}`, selfScheme: 'http:' }, allowlist),
    ).toBe('allow');
  });
});

describe('CORS response headers', () => {
  it('returns nothing for a non-allowlisted, absent, null, or malformed Origin', () => {
    for (const origin of ['https://attacker.example', undefined, 'null', 'nope']) {
      expect(corsResponseHeaders(origin, '/api/v0/health', allowlist)).toEqual({});
      expect(allowedRequestOrigin(origin, allowlist)).toBeUndefined();
    }
  });

  it('echoes the exact allowlisted origin, never a wildcard', () => {
    const headers = corsResponseHeaders(ALLOWED, '/api/v0/health', allowlist);
    expect(headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(headers['access-control-expose-headers']).toBe('x-request-id, retry-after, location');
  });

  it('advertises credentials for /app only', () => {
    expect(
      corsResponseHeaders(ALLOWED, '/app/home', allowlist)['access-control-allow-credentials'],
    ).toBe('true');
    expect(
      corsResponseHeaders(ALLOWED, '/app', allowlist)['access-control-allow-credentials'],
    ).toBe('true');
    expect(
      corsResponseHeaders(ALLOWED, '/api/v0/cases', allowlist)['access-control-allow-credentials'],
    ).toBeUndefined();
    expect(
      corsResponseHeaders(ALLOWED, '/application', allowlist)['access-control-allow-credentials'],
    ).toBeUndefined();
  });

  it('adds Vary: Origin to fallback responses whenever the allowlist is non-empty', () => {
    expect(corsFallbackHeaders('https://attacker.example', '/app', allowlist)).toEqual({
      vary: 'Origin',
    });
    expect(corsFallbackHeaders(ALLOWED, '/app', allowlist).vary).toBe('Origin');
    expect(corsFallbackHeaders(ALLOWED, '/app', new Set())).toEqual({});
  });
});

describe('parseAllowedOrigins', () => {
  it('treats unset and blank as an empty allowlist', () => {
    expect(parseAllowedOrigins(undefined, 'STAGING')).toEqual({ origins: [], issues: [] });
    expect(parseAllowedOrigins('  ', 'STAGING')).toEqual({ origins: [], issues: [] });
  });

  it('normalises, trims, and de-duplicates exact origins', () => {
    const parsed = parseAllowedOrigins(
      ' https://App.Example.org/ , https://app.example.org,https://other.example:8443 ',
      'STAGING',
    );
    expect(parsed.issues).toEqual([]);
    expect(parsed.origins).toEqual(['https://app.example.org', 'https://other.example:8443']);
  });

  it.each([
    ['a wildcard', '*'],
    ['a subdomain wildcard', 'https://*.example.org'],
    ['a wildcard port', 'https://app.example.org:*'],
    ['a trailing-dot host', 'https://app.example.org.'],
    ['a percent-encoded wildcard', 'https://%2a.example.org'],
    ['an upper-case percent-encoded wildcard', 'https://%2A.example.org'],
    ['an empty host label', 'https://app..example.org'],
    ['a leading empty host label', 'https://.example.org'],
    ['the null origin', 'null'],
    ['a bare host', 'app.example.org'],
    ['a path', 'https://app.example.org/path'],
    ['a query', 'https://app.example.org?x=1'],
    ['a fragment', 'https://app.example.org#x'],
    ['userinfo', 'https://user:pass@app.example.org'],
    ['a non-http scheme', 'ftp://app.example.org'],
    ['plain http on a public host', 'http://app.example.org'],
  ])('rejects %s', (_label, value) => {
    const parsed = parseAllowedOrigins(value, 'STAGING');
    expect(parsed.issues.length).toBeGreaterThan(0);
    expect(parsed.origins).toEqual([]);
  });

  it('requires https outside the LOCAL/TEST loopback exception, in every environment', () => {
    for (const environment of ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION']) {
      expect(parseAllowedOrigins('http://app.example.org', environment).origins).toEqual([]);
      expect(parseAllowedOrigins('ws://app.example.org', environment).origins).toEqual([]);
    }
  });

  it.each([
    ['localhost', 'https://localhost'],
    ['localhost with a port', 'https://localhost:8443'],
    ['a .localhost name', 'https://app.localhost'],
    ['an IPv4 literal', 'https://127.0.0.1'],
    ['a public IPv4 literal', 'https://203.0.113.7'],
    ['a hex IPv4 literal', 'https://0x7f000001'],
    ['a shortened IPv4 literal', 'https://127.1'],
    ['an IPv6 loopback literal', 'https://[::1]'],
    ['an IPv6 literal', 'https://[2001:db8::1]'],
  ])('rejects %s over https in STAGING and PRODUCTION', (_label, value) => {
    for (const environment of ['STAGING', 'PRODUCTION']) {
      const parsed = parseAllowedOrigins(value, environment);
      expect(parsed.origins).toEqual([]);
      expect(parsed.issues).toHaveLength(1);
    }
  });

  it('keeps https loopback and IP-literal origins usable in LOCAL and TEST', () => {
    for (const environment of ['LOCAL', 'TEST']) {
      expect(
        parseAllowedOrigins('https://localhost:8443,https://127.0.0.1,https://[::1]', environment),
      ).toEqual({
        origins: ['https://localhost:8443', 'https://127.0.0.1', 'https://[::1]'],
        issues: [],
      });
    }
  });

  it('still accepts a DNS name that merely contains "localhost"', () => {
    expect(parseAllowedOrigins('https://localhost-app.example.org', 'PRODUCTION')).toEqual({
      origins: ['https://localhost-app.example.org'],
      issues: [],
    });
  });

  it('keeps an explicit non-default port and drops the default one', () => {
    expect(
      parseAllowedOrigins('https://app.example.org:443,https://app.example.org:8443', 'STAGING'),
    ).toEqual({ origins: ['https://app.example.org', 'https://app.example.org:8443'], issues: [] });
  });

  it('allows http only for loopback hosts in LOCAL and TEST', () => {
    for (const environment of ['LOCAL', 'TEST']) {
      expect(
        parseAllowedOrigins(
          'http://localhost:5173,http://127.0.0.1:3001,http://[::1]:8080',
          environment,
        ),
      ).toEqual({
        origins: ['http://localhost:5173', 'http://127.0.0.1:3001', 'http://[::1]:8080'],
        issues: [],
      });
    }
    for (const environment of ['STAGING', 'PRODUCTION']) {
      expect(parseAllowedOrigins('http://localhost:5173', environment).issues).toHaveLength(1);
    }
  });

  it(`rejects more than ${MAX_CORS_ALLOWED_ORIGINS} origins`, () => {
    const many = Array.from(
      { length: MAX_CORS_ALLOWED_ORIGINS + 1 },
      (_v, i) => `https://o${i}.example`,
    );
    expect(parseAllowedOrigins(many.join(','), 'STAGING').issues).toHaveLength(1);
  });
});
