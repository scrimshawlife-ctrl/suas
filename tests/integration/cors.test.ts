/**
 * CORS and preflight for every endpoint (proposed SUAS-specs D-038).
 * Default-off behaviour is covered by the second describe block.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { listRegisteredApiRoutes } from '../../src/http/server.js';
import { validEnv } from '../helpers/env.js';

// The released pin is 0.6.0, and the D-038 startup guard refuses a non-empty allowlist
// below 0.7.0 in every environment. Mock only the guard's pin so this file can exercise
// the draft path; SPEC_VERSION and SUAS_SPEC_VERSION stay 0.6.0.
vi.mock('../../src/release/pins.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CORS_GUARD_SPEC_VERSION: '0.7.0',
}));

const ALLOWED = 'https://app.example.org';
const OTHER = 'https://attacker.example';
const SAMPLE_ID = '33333333-3333-4333-8333-333333333333';

/** `/app` routes covering GET pages, redirects, and form posts. */
const APP_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/'],
  ['GET', '/app'],
  ['GET', '/app/join'],
  ['POST', '/app/auth/challenges'],
  ['POST', '/app/auth/verify'],
  ['POST', '/app/auth/logout'],
  ['GET', '/app/home'],
  ['POST', '/app/qrf/deploy'],
  ['POST', '/app/qrf/cancel'],
  ['GET', '/app/check-ins'],
  ['POST', '/app/check-ins'],
  ['GET', '/app/resources'],
  ['GET', '/app/responder'],
  ['POST', '/app/responder/cases/x/commands/claim'],
  ['POST', '/app/admin/providers/enable'],
  ['GET', '/app/admin'],
];

function concretePath(path: string): string {
  return path.replace(/:[A-Za-z_]+/g, SAMPLE_ID);
}

let app: StartedApp;
let off: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_CORS_ALLOWED_ORIGINS: `${ALLOWED},http://localhost:5173` }),
    listen: false,
  });
  off = await startApp({ env: validEnv(), listen: false });
});

afterAll(async () => {
  await app.close();
  await off.close();
});

describe('preflight', () => {
  it('answers an allowlisted preflight with exact-origin CORS headers', async () => {
    const response = await app.server.inject({
      method: 'OPTIONS',
      url: '/api/v0/cases',
      headers: {
        origin: ALLOWED,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type, Idempotency-Key, X-Evil',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED);
    expect(response.headers['access-control-allow-methods']).toBe('GET, HEAD, POST, PUT, OPTIONS');
    // Only the headers this API reads are echoed; X-Evil is dropped.
    expect(response.headers['access-control-allow-headers']).toBe(
      'authorization, content-type, idempotency-key',
    );
    expect(response.headers['access-control-max-age']).toBe('600');
    expect(String(response.headers.vary)).toContain('Origin');
    expect(String(response.headers.vary)).toContain('Access-Control-Request-Method');
    // /api/v0 is Bearer-only: no credentials.
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
    // Security headers still apply to preflight responses.
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('advertises credentials for /app preflights only', async () => {
    const response = await app.server.inject({
      method: 'OPTIONS',
      url: '/app/auth/challenges',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('lists PUT for the one PUT route', async () => {
    const response = await app.server.inject({
      method: 'OPTIONS',
      url: '/api/v0/notifications/preferences',
      headers: { origin: ALLOWED, 'access-control-request-method': 'PUT' },
    });
    expect(response.statusCode).toBe(204);
    expect(String(response.headers['access-control-allow-methods'])).toContain('PUT');
  });

  it('answers a non-allowlisted preflight with 204 and no CORS headers', async () => {
    const response = await app.server.inject({
      method: 'OPTIONS',
      url: '/api/v0/cases',
      headers: { origin: OTHER, 'access-control-request-method': 'POST' },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['access-control-allow-methods']).toBeUndefined();
    expect(String(response.headers.vary)).toContain('Origin');
  });

  it('keeps the 404 for a plain OPTIONS request that is not a preflight', async () => {
    const response = await app.server.inject({ method: 'OPTIONS', url: '/api/v0/cases' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('every /api/v0 endpoint', () => {
  // Read after beforeAll has built the apps; at collection time the list is empty.
  const routes = (): ReturnType<typeof listRegisteredApiRoutes> => listRegisteredApiRoutes();

  it('registered at least the released surface', () => {
    expect(routes().length).toBeGreaterThanOrEqual(50);
  });

  it('answers a preflight for every method and path', async () => {
    for (const route of routes()) {
      const response = await app.server.inject({
        method: 'OPTIONS',
        url: concretePath(route.path),
        headers: { origin: ALLOWED, 'access-control-request-method': route.method },
      });
      expect(response.statusCode, `${route.method} ${route.path}`).toBe(204);
      expect(response.headers['access-control-allow-origin'], `${route.method} ${route.path}`).toBe(
        ALLOWED,
      );
    }
  });

  it('puts CORS headers on the real response for every method and path, errors included', async () => {
    for (const route of routes()) {
      const response = await app.server.inject({
        method: route.method as 'GET' | 'POST' | 'PUT',
        url: concretePath(route.path),
        headers: { origin: ALLOWED, 'sec-fetch-site': 'cross-site' },
      });
      const label = `${route.method} ${route.path} -> ${response.statusCode}`;
      expect(response.statusCode, label).not.toBe(403);
      expect(response.headers['access-control-allow-origin'], label).toBe(ALLOWED);
      expect(response.headers['access-control-expose-headers'], label).toContain('retry-after');
      expect(String(response.headers.vary), label).toContain('Origin');
      expect(response.headers['access-control-allow-credentials'], label).toBeUndefined();
    }
  });

  it('rejects every unsafe /api/v0 request from a non-allowlisted cross-site origin', async () => {
    for (const route of routes().filter((r) => r.method !== 'GET')) {
      const response = await app.server.inject({
        method: route.method as 'POST' | 'PUT',
        url: concretePath(route.path),
        headers: { origin: OTHER, 'sec-fetch-site': 'cross-site' },
      });
      const label = `${route.method} ${route.path}`;
      expect(response.statusCode, label).toBe(403);
      expect(response.headers['access-control-allow-origin'], label).toBeUndefined();
    }
  });
});

describe('/app endpoints', () => {
  it('puts credentialed CORS headers on pages, redirects, and form responses', async () => {
    for (const [method, url] of APP_ROUTES) {
      const response = await app.server.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: { origin: ALLOWED, 'sec-fetch-site': 'cross-site' },
      });
      const label = `${method} ${url} -> ${response.statusCode}`;
      expect(response.statusCode, label).not.toBe(403);
      expect(response.headers['access-control-allow-origin'], label).toBe(
        url === '/' ? ALLOWED : ALLOWED,
      );
      const credentialed = url === '/app' || url.startsWith('/app/');
      expect(response.headers['access-control-allow-credentials'], label).toBe(
        credentialed ? 'true' : undefined,
      );
    }
  });

  it('rejects unsafe /app requests from a non-allowlisted cross-site origin', async () => {
    for (const [, url] of APP_ROUTES.filter(([m]) => m === 'POST')) {
      const response = await app.server.inject({
        method: 'POST',
        url,
        headers: { origin: OTHER, 'sec-fetch-site': 'cross-site' },
      });
      expect(response.statusCode, url).toBe(403);
    }
  });

  it('exposes Retry-After and Location to allowlisted callers', async () => {
    const redirect = await app.server.inject({
      method: 'GET',
      url: '/',
      headers: { origin: ALLOWED },
    });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/app');
    expect(String(redirect.headers['access-control-expose-headers'])).toContain('location');
  });
});

describe('default-off: empty allowlist', () => {
  it('adds no CORS headers to any response and keeps preflight as 404', async () => {
    const preflight = await off.server.inject({
      method: 'OPTIONS',
      url: '/api/v0/cases',
      headers: { origin: ALLOWED, 'access-control-request-method': 'POST' },
    });
    expect(preflight.statusCode).toBe(404);

    for (const url of ['/api/v0/health', '/app', '/app/join', '/api/v0/not-a-route']) {
      const response = await off.server.inject({
        method: 'GET',
        url,
        headers: { origin: ALLOWED },
      });
      const names = Object.keys(response.headers).filter(
        (name) => name.startsWith('access-control-') || name === 'vary',
      );
      expect(names, url).toEqual([]);
    }
  });

  it('still rejects cross-site unsafe requests and accepts same-origin ones', async () => {
    const rejected = await off.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { origin: ALLOWED, 'sec-fetch-site': 'cross-site' },
    });
    expect(rejected.statusCode).toBe(403);

    const sameOrigin = await off.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
      payload: 'destination=nobody%40example.invalid&role=veteran',
    });
    // Browser auth is disabled in this app, so the handler answers 503, not 403.
    expect(sameOrigin.statusCode).toBe(503);
  });
});
