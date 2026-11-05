/**
 * Registry of a signed-in person's open WebSocket connections, and the lifecycle
 * the transports call into.
 *
 * Plan citation: V1_PROJECT_PLAN.md §2.2 (Chat), §4.3 F7. The registry is a table,
 * not process memory, so any instance can find a person's connections (AGENTS.md
 * rule 8). Connection ids are provider identifiers and are never logged with text.
 */

import type { Pool } from 'pg';
import type { Queryable } from '../db/index.js';
import type { ConnectionLifecycle } from '../realtime/lifecycle.js';
import { redeemConnectTicket } from './connect-tickets.js';
import { LIVE_SESSION_CONDITIONS } from './live-session.js';

export async function registerConnection(
  db: Queryable,
  input: {
    readonly connectionId: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly sessionId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO chat_connections (connection_id, tenant_id, user_id, session_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (connection_id) DO NOTHING`,
    [input.connectionId, input.tenantId, input.userId, input.sessionId],
  );
}

export async function removeConnection(db: Queryable, connectionId: string): Promise<void> {
  await db.query(`DELETE FROM chat_connections WHERE connection_id = $1`, [connectionId]);
}

/**
 * The person's connections whose session is still live and whose user is ACTIVE.
 * Connections of a revoked or expired session stay registered until they close but are
 * never returned, so a push cannot reach them.
 */
export async function listConnectionIds(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<readonly string[]> {
  const result = await db.query<{ connection_id: string }>(
    `SELECT c.connection_id
       FROM chat_connections c
       JOIN sessions s ON s.session_id = c.session_id
       JOIN users u ON u.user_id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE c.tenant_id = $1 AND c.user_id = $2 AND ${LIVE_SESSION_CONDITIONS}
      ORDER BY c.connected_at, c.connection_id`,
    [tenantId, userId],
  );
  return result.rows.map((row) => row.connection_id);
}

/** Connect authenticates by redeeming a ticket; disconnect drops the registry entry. */
export function createChatConnectionLifecycle(pool: Pool): ConnectionLifecycle {
  return {
    async connect({ connectionId, ticket }) {
      if (ticket === undefined || ticket === '') return 'refused';
      const redeemed = await redeemConnectTicket(pool, ticket);
      if (redeemed === undefined) return 'refused';
      await registerConnection(pool, { connectionId, ...redeemed });
      return 'accepted';
    },
    disconnect: (connectionId) => removeConnection(pool, connectionId),
  };
}
