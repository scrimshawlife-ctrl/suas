/**
 * SQL for "this session may still act", for queries that alias `sessions` as `s` and
 * `users` as `u`. A WebSocket connection outlives the request that authorized it, so
 * connect and push both re-check these conditions (AUTH.md §5: revocation and user
 * status are evaluated live, never trusted from an earlier check).
 */
export const LIVE_SESSION_CONDITIONS = `s.revoked_at IS NULL AND s.expires_at > now()
        AND u.status = 'ACTIVE' AND u.deleted_at IS NULL`;
