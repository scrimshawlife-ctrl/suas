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

// No trailing slash: `/api/v0/auth%2Fchallenges` must match once decoded.
const AUTH_PATH_PREFIXES = [`${API_PREFIX}/auth`, '/app/auth'] as const;
const CHALLENGE_ROUTES = new Set([`${API_PREFIX}/auth/challenges`, '/app/auth/challenges']);
const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;

/** One round of byte-wise %XX decoding. A malformed escape stays as it is, so this never throws. */
function decodeEscapes(path: string): string {
  return path.replace(PERCENT_ESCAPE, (_escape, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * True when the raw URL path holds any `%` and, lower-cased and decoded until stable, starts with
 * an auth prefix (R16.2, contributor's call, D-065). No round cap (review of #366, 2026-11-25):
 * each round that changes the path shortens it, so decoding always stops.
 */
export function isPercentEncodedAuthPath(rawUrl: string): boolean {
  const path = rawUrl.split('?', 1)[0] ?? '';
  if (!path.includes('%')) return false;
  let decoded = path.toLowerCase();
  let next = decodeEscapes(decoded).toLowerCase();
  while (next !== decoded) {
    decoded = next;
    next = decodeEscapes(decoded).toLowerCase();
  }
  return AUTH_PATH_PREFIXES.some((prefix) => decoded.startsWith(prefix));
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
  // Global on purpose: D-036 Option C allows no network-signal (per-IP) budget, and the address
  // and account limits still bound each address. A per-caller key needs the owner to change D-036.
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
