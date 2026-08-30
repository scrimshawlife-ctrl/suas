/**
 * Request authentication.
 *
 * Spec citations:
 * - SUAS-specs API.md §4 — every non-auth request requires an authenticated
 *   session unless explicitly documented otherwise; the server derives tenant and
 *   actor authority.
 * - SUAS-specs AUTH.md §5 — authoritative session/user state is re-evaluated per
 *   request, never taken from a client claim.
 * - SUAS-specs SECURITY.md §2 — no sensitive data in logs.
 */

import type { FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { resolveAuthContext, type AuthContext } from '../authz/index.js';
import { UnauthenticatedError } from '../authz/index.js';

export const BROWSER_SESSION_COOKIE = '__Secure-suas_session';

function readCookie(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (typeof header !== 'string') return undefined;
  for (const part of header.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function assertSameOriginBrowserWrite(request: FastifyRequest): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') {
    throw new UnauthenticatedError('Cross-origin browser requests are not accepted.');
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (typeof origin === 'string' && typeof host === 'string') {
    let originHost: string | undefined;
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = undefined;
    }
    if (originHost !== host) {
      throw new UnauthenticatedError('Cross-origin browser requests are not accepted.');
    }
  }
}

/** Extract the opaque session credential from the Authorization header. */
export function readCredential(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function readBrowserCredential(request: FastifyRequest): string | undefined {
  if (!request.url.split('?')[0]?.startsWith('/app')) return undefined;
  const credential = readCookie(request, BROWSER_SESSION_COOKIE);
  if (credential !== undefined) assertSameOriginBrowserWrite(request);
  return credential;
}

/**
 * Resolve the authenticated context or throw 401.
 *
 * The rejection reason is logged but never returned: a caller learns that the
 * credential did not work, not whether it was revoked, expired, or never existed.
 */
export async function authenticate(
  pool: Pool,
  sessionSecret: string | undefined,
  request: FastifyRequest,
): Promise<AuthContext> {
  const credential = readCredential(request) ?? readBrowserCredential(request);
  if (credential === undefined) {
    throw new UnauthenticatedError('A session credential is required.');
  }

  const resolution = await resolveAuthContext(pool, sessionSecret, credential);
  if (!resolution.ok) {
    request.log.info({ auth_rejection: resolution.reason }, 'session rejected');
    throw new UnauthenticatedError('The session credential is not valid.');
  }
  return resolution.context;
}
