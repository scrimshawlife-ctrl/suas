/**
 * The caller's chat threads, newest activity first.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 "Peer flow" (a thread exists only between the
 * requester and the person who accepted), §4.3 F7. A person sees only threads they are
 * a participant of. The last message body is sensitive free text: it is shortened here,
 * returned to the participant, and never logged.
 */

import type { Queryable } from '../db/index.js';
import { TERMINAL_REQUEST_STATUSES } from '../coordination/request-transitions.js';

/** A list row shows a preview, not the whole message. */
export const LAST_MESSAGE_PREVIEW_MAX = 140;
/** API.md §5: lists are bounded. A person has few threads, so there is no cursor yet. */
export const CHAT_THREAD_LIST_MAX = 100;

export interface ChatThreadSummary {
  readonly serviceRequestId: string;
  readonly category: string;
  readonly summary: string | null;
  readonly counterpartDisplayName: string | null;
  readonly lastMessageBody: string | null;
  readonly lastMessageAt: Date | null;
  /** The request is in a terminal status. */
  readonly closed: boolean;
}

interface ThreadRow {
  service_request_id: string;
  category: string;
  status: string;
  summary: string | null;
  counterpart_display_name: string | null;
  last_message_body: string | null;
  last_message_at: Date | null;
}

export async function listChatThreads(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<ChatThreadSummary[]> {
  const result = await db.query<ThreadRow>(
    `SELECT t.service_request_id, r.category, r.status, r.details->>'summary' AS summary,
            cp.display_name AS counterpart_display_name,
            m.preview AS last_message_body, m.created_at AS last_message_at
       FROM chat_threads t
       JOIN service_requests r
         ON r.service_request_id = t.service_request_id AND r.tenant_id = t.tenant_id
       JOIN users cp
         ON cp.tenant_id = t.tenant_id
        AND cp.user_id = CASE WHEN t.requester_user_id = $2::uuid
                              THEN t.accepted_by_user_id ELSE t.requester_user_id END
       LEFT JOIN LATERAL (
         SELECT left(body, $3::int) AS preview, created_at
           FROM chat_messages
          WHERE chat_thread_id = t.chat_thread_id AND tenant_id = t.tenant_id
          ORDER BY created_at DESC, chat_message_id DESC
          LIMIT 1
       ) m ON true
      WHERE t.tenant_id = $1
        AND (t.requester_user_id = $2::uuid OR t.accepted_by_user_id = $2::uuid)
      ORDER BY COALESCE(m.created_at, t.created_at) DESC, t.chat_thread_id DESC
      LIMIT $4::int`,
    [tenantId, userId, LAST_MESSAGE_PREVIEW_MAX, CHAT_THREAD_LIST_MAX],
  );
  return result.rows.map((row) => ({
    serviceRequestId: row.service_request_id,
    category: row.category,
    summary: row.summary,
    counterpartDisplayName: row.counterpart_display_name,
    lastMessageBody: row.last_message_body,
    lastMessageAt: row.last_message_at,
    closed: (TERMINAL_REQUEST_STATUSES as readonly string[]).includes(row.status),
  }));
}
