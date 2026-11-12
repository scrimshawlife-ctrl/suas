/**
 * The caller's chat threads, newest activity first.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 "Peer flow" (a thread exists only between the
 * requester and the person who accepted), §4.3 F7. A person sees only threads they are
 * a participant of. A released thread stays listed for the requester, with `releasedAt`; the
 * released helper no longer sees it. The last message body is sensitive free text: it is shortened here,
 * returned to the participant, and never logged.
 */

import type { Queryable } from '../db/index.js';
import { TERMINAL_REQUEST_STATUSES } from '../coordination/request-transitions.js';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  pageSize,
  takePage,
  type PageRequest,
  timestampText,
} from '../http/cursor.js';

/** A list row shows a preview, not the whole message. */
export const LAST_MESSAGE_PREVIEW_MAX = 140;
/** Latest activity: the newest message, or the accept that opened the thread. */
const ACTIVITY = 'COALESCE(m.created_at, t.created_at)';

export interface ChatThreadSummary {
  readonly chatThreadId: string;
  readonly serviceRequestId: string;
  readonly category: string;
  readonly summary: string | null;
  readonly counterpartDisplayName: string | null;
  readonly lastMessageBody: string | null;
  readonly lastMessageAt: Date | null;
  /** When this thread was made: the accept transaction that opened it. */
  readonly acceptedAt: Date;
  /** When a release ended this thread; null while it is live. */
  readonly releasedAt: Date | null;
  /** The request is in a terminal status. */
  readonly closed: boolean;
  /** The caller's side of the thread. */
  readonly role: 'REQUESTER' | 'ACCEPTER';
  /** Whether the latest message is the caller's own; null when there are no messages. */
  readonly lastMessageFromMe: boolean | null;
}

interface ThreadRow {
  chat_thread_id: string;
  service_request_id: string;
  category: string;
  status: string;
  summary: string | null;
  counterpart_display_name: string | null;
  last_message_body: string | null;
  last_message_at: Date | null;
  accepted_at: Date;
  released_at: Date | null;
  role: 'REQUESTER' | 'ACCEPTER';
  last_message_from_me: boolean | null;
  activity_key: string;
}

/**
 * API.md §5 keyset page over (activity, chat_thread_id), newest first. A thread that gets a
 * new message moves to the top, so a client re-reads the first page to see it.
 */
export async function listChatThreads(
  db: Queryable,
  tenantId: string,
  userId: string,
  page: PageRequest = {},
): Promise<{ threads: ChatThreadSummary[]; nextCursor: string | undefined }> {
  const limit = pageSize(page.limit);
  const values: unknown[] = [tenantId, userId, LAST_MESSAGE_PREVIEW_MAX];
  let cursorCondition = '';
  if (page.cursor !== undefined) {
    const { at, id } = decodeTimeIdCursor(page.cursor);
    values.push(at, id);
    cursorCondition = `AND (${ACTIVITY}, t.chat_thread_id) < ($4::timestamptz, $5::uuid)`;
  }
  values.push(limit + 1);
  const result = await db.query<ThreadRow>(
    `SELECT t.chat_thread_id, t.service_request_id, r.category, r.status, CASE WHEN jsonb_typeof(r.details->'summary') = 'string'
                 THEN left(r.details->>'summary', 280) END AS summary,
            cp.display_name AS counterpart_display_name,
            m.preview AS last_message_body, m.created_at AS last_message_at, t.created_at AS accepted_at, t.released_at,
            CASE WHEN t.requester_user_id = $2::uuid THEN 'REQUESTER' ELSE 'ACCEPTER' END AS role,
            m.sender_user_id = $2::uuid AS last_message_from_me,
            ${timestampText(ACTIVITY)} AS activity_key
       FROM chat_threads t
       JOIN service_requests r
         ON r.service_request_id = t.service_request_id AND r.tenant_id = t.tenant_id
       JOIN support_cases c
         ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
       JOIN users cp
         ON cp.tenant_id = t.tenant_id
        AND cp.user_id = CASE WHEN t.requester_user_id = $2::uuid
                              THEN t.accepted_by_user_id ELSE t.requester_user_id END
       LEFT JOIN LATERAL (
         SELECT left(body, $3::int) AS preview, created_at, sender_user_id
           FROM chat_messages
          WHERE chat_thread_id = t.chat_thread_id AND tenant_id = t.tenant_id
          ORDER BY created_at DESC, chat_message_id DESC
          LIMIT 1
       ) m ON true
      WHERE t.tenant_id = $1
        AND (
          t.requester_user_id = $2::uuid
          OR (
            t.accepted_by_user_id = $2::uuid
            AND t.released_at IS NULL
            AND c.status <> 'CLOSED'
            AND (c.closed_at IS NULL OR r.created_at > c.closed_at)
          )
        )
        ${cursorCondition}
      ORDER BY ${ACTIVITY} DESC, t.chat_thread_id DESC
      LIMIT $${values.length}::int`,
    values,
  );
  const { rows, nextCursor } = takePage(result.rows, limit, (row) =>
    encodeTimeIdCursor({ at: row.activity_key, id: row.chat_thread_id }),
  );
  const threads = rows.map((row) => ({
    chatThreadId: row.chat_thread_id,
    serviceRequestId: row.service_request_id,
    category: row.category,
    summary: row.summary,
    counterpartDisplayName: row.counterpart_display_name,
    lastMessageBody: row.last_message_body,
    lastMessageAt: row.last_message_at,
    acceptedAt: row.accepted_at,
    releasedAt: row.released_at,
    role: row.role,
    lastMessageFromMe: row.last_message_from_me,
    closed: (TERMINAL_REQUEST_STATUSES as readonly string[]).includes(row.status),
  }));
  return { threads, nextCursor };
}
