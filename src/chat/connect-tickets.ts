/**
 * One-time WebSocket connect tickets.
 *
 * Plan citation: V1_PROJECT_PLAN.md §2.2 (Chat), §4.3 F7. Browsers cannot set an
 * Authorization header on a WebSocket and the session credential must not appear in
 * a URL, so an authenticated REST call issues a short-lived, single-use ticket bound
 * to the signed-in person and the WebSocket `$connect` redeems it exactly once.
 *
 * Only the SHA-256 of the ticket is stored. The ticket is 256 random bits, so a
 * plain hash is enough: there is nothing to brute-force.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from '../db/index.js';
import { LIVE_SESSION_CONDITIONS } from './live-session.js';

export const CONNECT_TICKET_TTL_SECONDS = 60;

export interface IssuedConnectTicket {
  readonly ticket: string;
  readonly expiresAt: Date;
}

export interface RedeemedConnectTicket {
  readonly tenantId: string;
  readonly userId: string;
  /** The session that issued the ticket; the connection inherits it. */
  readonly sessionId: string;
}

function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

export async function issueConnectTicket(
  db: Queryable,
  input: { readonly tenantId: string; readonly userId: string; readonly sessionId: string },
): Promise<IssuedConnectTicket> {
  // Redeemed or long-expired tickets have no further use; sweep them as we go.
  await db.query(`DELETE FROM chat_connect_tickets WHERE expires_at < now() - interval '1 hour'`);

  const ticket = randomBytes(32).toString('base64url');
  const result = await db.query<{ expires_at: Date }>(
    `INSERT INTO chat_connect_tickets (ticket_hash, tenant_id, user_id, session_id, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
     RETURNING expires_at`,
    [hashTicket(ticket), input.tenantId, input.userId, input.sessionId, CONNECT_TICKET_TTL_SECONDS],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Connect ticket insert returned no row.');
  return { ticket, expiresAt: row.expires_at };
}

/**
 * Marks the ticket used and returns who it was issued to, or undefined when it is
 * unknown, expired or already used, or when its session is no longer live. The single
 * UPDATE is the atomic single-use guarantee: two concurrent connects cannot both win.
 */
export async function redeemConnectTicket(
  db: Queryable,
  ticket: string,
): Promise<RedeemedConnectTicket | undefined> {
  const result = await db.query<{ tenant_id: string; user_id: string; session_id: string }>(
    `UPDATE chat_connect_tickets t
        SET redeemed_at = now()
       FROM sessions s
       JOIN users u ON u.user_id = s.user_id AND u.tenant_id = s.tenant_id
      WHERE t.ticket_hash = $1 AND t.redeemed_at IS NULL AND t.expires_at > now()
        AND s.session_id = t.session_id AND ${LIVE_SESSION_CONDITIONS}
      RETURNING t.tenant_id, t.user_id, t.session_id`,
    [hashTicket(ticket)],
  );
  const row = result.rows[0];
  return row === undefined
    ? undefined
    : { tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id };
}
