/**
 * Guards on the sign-in routes that no single route owns (R16.2, contributor proposal, not
 * released / owner review on #363): a 404 for percent-encoded auth paths, which could miss the
 * API Gateway route throttle, and the public demo's in-app limit on challenge requests.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { PUBLIC_DEMO_ROUTE_WINDOW_SECONDS } from '../auth/constants.js';
import { enforceRateLimit } from '../auth/rate-limit.js';
import { activePublicDemoLimits, type StagingAccess } from '../auth/staging-access.js';
import { API_PREFIX } from '../release/pins.js';
import { errorBody } from './error-envelope.js';

const AUTH_PATH_PREFIXES = [`${API_PREFIX}/auth/`, '/app/auth/'] as const;
const CHALLENGE_ROUTES = new Set([`${API_PREFIX}/auth/challenges`, '/app/auth/challenges']);
const PERCENT_ESCAPE = /%([0-9A-Fa-f]{2})/g;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/**
 * True when the raw URL path is under an auth prefix once its unreserved escapes are decoded (as
 * the router decodes them) and it holds at least one such escape, like `/api/v0/auth/%63hallenges`.
 */
export function isPercentEncodedAuthPath(rawUrl: string): boolean {
  const path = rawUrl.split('?', 1)[0] ?? '';
  let encoded = false;
  const decoded = path.replace(PERCENT_ESCAPE, (escape, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    if (!UNRESERVED.test(char)) return escape;
    encoded = true;
    return char;
  });
  return encoded && AUTH_PATH_PREFIXES.some((prefix) => decoded.startsWith(prefix));
}

/** Registered right after the server hooks, so the 404 comes before any other hook or handler. */
export function registerAuthRouteGuards(
  app: FastifyInstance,
  deps: { readonly stagingAccess: StagingAccess; readonly pool: Pool | undefined },
): void {
  app.addHook('onRequest', async (request, reply) => {
    if (isPercentEncodedAuthPath(request.raw.url ?? request.url)) {
      return reply.status(404).send(errorBody('NOT_FOUND', 'Resource not found.'));
    }
  });

  // One shared per-minute budget over both challenge routes, as a bound that holds whatever path
  // variant reached the app. Over it the answer is the usual 429 RATE_LIMITED with Retry-After.
  const { pool } = deps;
  const limits = activePublicDemoLimits(deps.stagingAccess);
  if (limits === undefined || pool === undefined) return;
  app.addHook('preHandler', async (request) => {
    if (request.method !== 'POST' || !CHALLENGE_ROUTES.has(request.routeOptions.url ?? '')) return;
    await enforceRateLimit(
      pool,
      {
        bucket: 'auth.challenge.route',
        limit: limits.routeLimitPerMinute,
        windowSeconds: PUBLIC_DEMO_ROUTE_WINDOW_SECONDS.value,
      },
      'global',
    );
  });
}
