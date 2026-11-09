/**
 * Chat thread creation and closing.
 *
 * V1_PROJECT_PLAN.md §2.1 "Peer flow": one live chat thread per Service Request, only
 * between the requester and the person who accepted. The thread is created in the accept
 * transaction. A release (R8.5) closes it; the next accept opens a new one. Reading and
 * posting messages belong to the chat feature (plan F7).
 */

import type { Queryable } from '../db/transaction.js';
import { randomUUID } from 'node:crypto';

export interface ChatThread {
  readonly chatThreadId: string;
  readonly serviceRequestId: string;
  readonly requesterUserId: string;
  readonly acceptedByUserId: string;
}

/** Idempotent: a second call for the same request returns its live thread. */
export async function createChatThreadInTx(
  tx: Queryable,
  input: {
    tenantId: string;
    serviceRequestId: string;
    requesterUserId: string;
    acceptedByUserId: string;
  },
): Promise<ChatThread> {
  const result = await tx.query<{
    chat_thread_id: string;
    service_request_id: string;
    requester_user_id: string;
    accepted_by_user_id: string;
  }>(
    `WITH inserted AS (
       INSERT INTO chat_threads
         (chat_thread_id, tenant_id, service_request_id, requester_user_id, accepted_by_user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (service_request_id) WHERE released_at IS NULL DO NOTHING
       RETURNING chat_thread_id, service_request_id, requester_user_id, accepted_by_user_id
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT chat_thread_id, service_request_id, requester_user_id, accepted_by_user_id
       FROM chat_threads
      WHERE service_request_id = $3 AND tenant_id = $2 AND released_at IS NULL
     LIMIT 1`,
    [
      randomUUID(),
      input.tenantId,
      input.serviceRequestId,
      input.requesterUserId,
      input.acceptedByUserId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Chat thread insert returned no row.');
  return {
    chatThreadId: row.chat_thread_id,
    serviceRequestId: row.service_request_id,
    requesterUserId: row.requester_user_id,
    acceptedByUserId: row.accepted_by_user_id,
  };
}

/** Close the request's live thread, if any. Returns whether one was closed. */
export async function closeChatThreadInTx(
  tx: Queryable,
  input: { tenantId: string; serviceRequestId: string },
): Promise<boolean> {
  const result = await tx.query(
    `UPDATE chat_threads SET released_at = now()
      WHERE tenant_id = $1 AND service_request_id = $2 AND released_at IS NULL`,
    [input.tenantId, input.serviceRequestId],
  );
  return (result.rowCount ?? 0) > 0;
}
