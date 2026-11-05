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
import { stagingFixturePrincipalRefused, type StagingAccess } from '../auth/staging-access.js';
import { resolveAuthContext, type AuthContext } from '../authz/index.js';
import { UnauthenticatedError } from '../authz/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for every request. STAGING uses it to refuse a non-fixture session. */
    stagingAccess?: StagingAccess;
  }
}

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

/** Extract the opaque session credential from the Authorization header. */
export function readCredential(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1];
}

function readBrowserCredential(request: FastifyRequest): string | undefined {
  if (!request.url.split('?')[0]?.startsWith('/app')) return undefined;
  // No Origin / Sec-Fetch-Site check here. With a non-empty CORS allowlist the cookie
  // is `SameSite=None` and can ride on cross-site requests; CSRF is blocked earlier by
  // the global origin policy (`registerOriginPolicy`), which rejects unsafe browser
  // requests that are not same-origin or allowlisted, and cookie-carrying writes that
  // send neither header. /app pages send `referrer-policy: no-referrer`, so
  // browsers send `Origin: null` on same-origin form posts, which that policy
  // accepts via `Sec-Fetch-Site: same-origin`.
  return readCookie(request, BROWSER_SESSION_COOKIE);
}

/**
 * True when `authenticate` would use the `/app` session cookie for this request: an
 * `/app` request with the cookie and no Bearer credential.
 */
export function usesBrowserCookie(request: FastifyRequest): boolean {
  return readCredential(request) === undefined && readBrowserCredential(request) !== undefined;
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

  const stagingAccess = request.stagingAccess;
  if (
    stagingAccess !== undefined &&
    stagingFixturePrincipalRefused(stagingAccess, {
      tenantId: resolution.context.tenantId,
      userId: resolution.context.userId,
    })
  ) {
    request.log.info({ auth_rejection: 'not_staging_fixture' }, 'session rejected');
    throw new UnauthenticatedError('The session credential is not valid.');
  }
  return resolution.context;
}
