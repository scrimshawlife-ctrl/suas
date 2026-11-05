/**
 * Browser origin policy and CORS.
 *
 * Spec citations (D-038, released in SUAS-specs 0.7.0):
 * - SUAS-specs AUTH.md §9.1 / §9.3 — cross-origin request policy for the
 *   browser surface and the JSON API.
 * - SUAS-specs ENVIRONMENT.md §3 — `SUAS_CORS_ALLOWED_ORIGINS`.
 * - SUAS-specs API.md §6 — canonical error body (`FORBIDDEN`, 403).
 *
 * Two independent pieces live here:
 *
 * 1. Request policy. Every browser-originated *unsafe* request (POST/PUT/PATCH/
 *    DELETE) must be same-origin or come from an allowlisted origin. This is the
 *    CSRF defence for the session cookie (`SameSite=None` only when the allowlist
 *    is non-empty) and for the sign-in forms. It runs before body parsing, authentication, rate limiting, and email
 *    delivery, so a denied request has no side effect.
 * 2. CORS. Allowlisted origins get `Access-Control-*` response headers and
 *    preflight answers. An empty allowlist means no CORS headers at all.
 *
 * Non-browser clients (curl, Postman, the native iOS and Android apps) send neither
 * `Origin` nor `Sec-Fetch-Site`, use Bearer, and are not affected. A request that
 * carries the `/app` session cookie with neither header is denied.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ForbiddenError } from '../authz/index.js';
import { usesBrowserCookie } from './authenticate.js';

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const ALLOW_METHODS = 'GET, HEAD, POST, PUT, PATCH, OPTIONS';
const ALLOWED_REQUEST_HEADERS = new Set([
  'authorization',
  'content-type',
  'idempotency-key',
  'x-request-id',
]);
const EXPOSE_HEADERS = 'x-request-id, retry-after, location';
const PREFLIGHT_MAX_AGE_SECONDS = '600';

export interface BrowserRequestHeaders {
  readonly secFetchSite: string | undefined;
  readonly origin: string | undefined;
  readonly host: string | undefined;
  /**
   * The server's own scheme, with the trailing colon (`https:` or `http:`). The
   * no-Sec-Fetch-Site fallback matches `Origin` against scheme and host.
   */
  readonly selfScheme: string;
  /**
   * True when the request would be authenticated by the `/app` session cookie (an
   * `/app` request carrying the cookie and no `Authorization` header).
   */
  readonly cookieSession: boolean;
}

export type BrowserRequestVerdict = 'allow' | 'deny';

type OriginState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'null' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'origin';
      readonly origin: string;
      readonly protocol: string;
      readonly host: string;
    };

function classifyOrigin(origin: string | undefined): OriginState {
  if (origin === undefined) return { kind: 'absent' };
  if (origin === 'null') return { kind: 'null' };
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'invalid' };
    return { kind: 'origin', origin: url.origin, protocol: url.protocol, host: url.host };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Decide whether a browser-originated unsafe request may proceed.
 *
 * | Sec-Fetch-Site         | Origin                           | Verdict |
 * |------------------------|----------------------------------|---------|
 * | same-origin, none      | any (including "null")           | allow   |
 * | same-site, cross-site  | allowlisted                      | allow   |
 * | same-site, cross-site  | "null", absent, or not listed    | deny    |
 * | absent                 | absent, /app cookie session      | deny    |
 * | absent                 | absent, no cookie (non-browser)  | allow   |
 * | absent                 | same scheme+host, or allowlisted | allow   |
 * | absent                 | "null" or any other origin       | deny    |
 *
 * An unrecognised Sec-Fetch-Site value is treated as cross-site (fail closed).
 */
export function evaluateBrowserRequest(
  headers: BrowserRequestHeaders,
  allowlist: ReadonlySet<string>,
): BrowserRequestVerdict {
  const site = headers.secFetchSite?.trim().toLowerCase();
  if (site === 'same-origin' || site === 'none') return 'allow';

  const origin = classifyOrigin(headers.origin);

  if (site === undefined || site === '') {
    // Non-browser clients use Bearer. A cookie-carrying write with no metadata at all is
    // a browser that sends none (for example an old one) and is not trusted.
    if (origin.kind === 'absent') return headers.cookieSession ? 'deny' : 'allow';
    if (origin.kind === 'origin') {
      const sameOrigin =
        origin.protocol === headers.selfScheme &&
        headers.host !== undefined &&
        origin.host === headers.host.toLowerCase();
      return sameOrigin || allowlist.has(origin.origin) ? 'allow' : 'deny';
    }
    return 'deny';
  }

  // same-site, cross-site, or an unrecognised value.
  return origin.kind === 'origin' && allowlist.has(origin.origin) ? 'allow' : 'deny';
}

function isAppPath(pathname: string): boolean {
  return pathname === '/app' || pathname.startsWith('/app/');
}

function pathnameOf(url: string): string {
  const queryAt = url.indexOf('?');
  return queryAt === -1 ? url : url.slice(0, queryAt);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The allowlisted origin a request came from, or undefined. */
export function allowedRequestOrigin(
  origin: string | undefined,
  allowlist: ReadonlySet<string>,
): string | undefined {
  const parsed = classifyOrigin(origin);
  return parsed.kind === 'origin' && allowlist.has(parsed.origin) ? parsed.origin : undefined;
}

/**
 * CORS response headers for one request. Empty unless the request's Origin is
 * allowlisted. Credentials are advertised for `/app` only; `/api/v0` is Bearer-only
 * and never reads cookies.
 */
export function corsResponseHeaders(
  origin: string | undefined,
  pathname: string,
  allowlist: ReadonlySet<string>,
): Record<string, string> {
  const allowed = allowedRequestOrigin(origin, allowlist);
  if (allowed === undefined) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-expose-headers': EXPOSE_HEADERS,
    ...(isAppPath(pathname) ? { 'access-control-allow-credentials': 'true' } : {}),
  };
}

function appendVary(reply: FastifyReply, ...values: string[]): void {
  const existing = reply.getHeader('vary');
  const current = (Array.isArray(existing) ? existing.join(',') : String(existing ?? ''))
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const seen = new Set(current.map((part) => part.toLowerCase()));
  for (const value of values) {
    if (!seen.has(value.toLowerCase())) current.push(value);
  }
  void reply.header('vary', current.join(', '));
}

/**
 * Headers for responses built outside Fastify (the Worker's own 500). Includes
 * `Vary: Origin` whenever the allowlist is non-empty.
 */
export function corsFallbackHeaders(
  origin: string | undefined,
  pathname: string,
  allowlist: ReadonlySet<string>,
): Record<string, string> {
  if (allowlist.size === 0) return {};
  return { ...corsResponseHeaders(origin, pathname, allowlist), vary: 'Origin' };
}

function requestedHeadersAllowed(requested: string | undefined): string | undefined {
  if (requested === undefined) return undefined;
  const allowed = requested
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => ALLOWED_REQUEST_HEADERS.has(name));
  return allowed.length === 0 ? undefined : [...new Set(allowed)].join(', ');
}

export interface OriginPolicyOptions {
  readonly allowlist: ReadonlySet<string>;
  /** `SUAS_ENV`. STAGING and PRODUCTION are always served over https. */
  readonly environment: string;
}

const HTTPS_ONLY_ENVIRONMENTS = new Set(['STAGING', 'PRODUCTION']);

/**
 * The scheme this server is reached on. Shared deployments are always https (the
 * session cookie is `Secure`); LOCAL and TEST use the connection's own protocol.
 */
function selfSchemeOf(request: FastifyRequest, environment: string): string {
  if (HTTPS_ONLY_ENVIRONMENTS.has(environment)) return 'https:';
  return request.protocol === 'https' ? 'https:' : 'http:';
}

/**
 * Register the unsafe-request policy, the preflight handler, and the CORS response
 * headers. Call once from `createServer`.
 */
export function registerOriginPolicy(app: FastifyInstance, options: OriginPolicyOptions): void {
  const { allowlist, environment } = options;

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const origin = firstHeader(request.headers.origin);

    // Preflight: OPTIONS + Origin + Access-Control-Request-Method. With no allowlist
    // the feature is off and OPTIONS keeps falling through to the 404 handler.
    if (
      request.method === 'OPTIONS' &&
      allowlist.size > 0 &&
      origin !== undefined &&
      request.headers['access-control-request-method'] !== undefined
    ) {
      const pathname = pathnameOf(request.url);
      const headers = corsResponseHeaders(origin, pathname, allowlist);
      if (Object.keys(headers).length > 0) {
        void reply.headers({
          'access-control-allow-origin': headers['access-control-allow-origin'] ?? '',
          'access-control-allow-methods': ALLOW_METHODS,
          'access-control-max-age': PREFLIGHT_MAX_AGE_SECONDS,
          ...(headers['access-control-allow-credentials'] === undefined
            ? {}
            : { 'access-control-allow-credentials': 'true' }),
        });
        const allowedHeaders = requestedHeadersAllowed(
          firstHeader(request.headers['access-control-request-headers']),
        );
        if (allowedHeaders !== undefined) {
          void reply.header('access-control-allow-headers', allowedHeaders);
        }
      }
      appendVary(
        reply,
        'Origin',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers',
      );
      return reply.code(204).send();
    }

    if (!UNSAFE_METHODS.has(request.method)) return;

    const verdict = evaluateBrowserRequest(
      {
        secFetchSite: firstHeader(request.headers['sec-fetch-site']),
        origin,
        host: firstHeader(request.headers.host),
        selfScheme: selfSchemeOf(request, environment),
        cookieSession: usesBrowserCookie(request),
      },
      allowlist,
    );
    if (verdict === 'deny') {
      throw new ForbiddenError('Cross-origin browser requests from this origin are not accepted.');
    }
  });

  app.addHook('onSend', (request, reply, payload, done) => {
    if (allowlist.size > 0) {
      const headers = corsResponseHeaders(
        firstHeader(request.headers.origin),
        pathnameOf(request.url),
        allowlist,
      );
      for (const [name, value] of Object.entries(headers)) {
        void reply.header(name, value);
      }
      appendVary(reply, 'Origin');
    }
    done(null, payload);
  });
}
