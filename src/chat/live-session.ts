import { SESSION_IDLE_TTL_SECONDS } from '../auth/constants.js';

/**
 * SQL for "this session may still act", for queries that alias `sessions` as `s` and
 * `users` as `u`. A WebSocket connection outlives the request that authorized it, so
 * connect and push both re-check these conditions (AUTH.md §5: revocation and user
 * status are evaluated live, never trusted from an earlier check).
 *
 * Mirrors `resolveSession`: revoked, past its absolute expiry, idle longer than the
 * idle TTL (the same constant), or user not ACTIVE all mean the session is dead.
 */
export const LIVE_SESSION_CONDITIONS = `s.revoked_at IS NULL AND s.expires_at > now()
        AND s.last_seen_at >= now() - make_interval(secs => ${String(SESSION_IDLE_TTL_SECONDS.value)})
        AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`;
