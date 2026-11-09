/**
 * Who may read or write a Service Request's chat.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 "Peer flow" (chat is only between the
 * requester and the person who accepted), §4.3 F7; SUAS-specs API.md §4 (no
 * existence leakage).
 *
 * A thread is created when a request is accepted (migration 0013), so "no thread"
 * means "not accepted yet". Only the requester is told chat is unavailable; anyone
 * else gets the same 404 as a request that does not exist. A release closes the thread
 * (migration 0020): the requester can still read it, the released helper loses it, and
 * the next accept opens a new live thread, which is the one a request resolves to.
 * A caller may name one thread of the request to read (R8.11): a closed thread opens only
 * for the requester, and any thread that is not this request's, or not theirs, is a 404.
 */

import { ResourceNotVisibleError } from '../authz/index.js';
import { requestHeldInCurrentCycle } from '../coordination/cases.js';
import type { Queryable } from '../db/index.js';

/** The request has not been accepted, so there is nobody to chat with yet. */
export class ChatUnavailableError extends Error {
  readonly code = 'CHAT_UNAVAILABLE';
  readonly httpStatus = 409;

  constructor() {
    super('Chat opens once someone accepts this request.');
    this.name = 'ChatUnavailableError';
  }
}

/** The thread was closed by a release, so nobody can post to it. */
export class ChatClosedError extends Error {
  readonly code = 'CHAT_CLOSED';
  readonly httpStatus = 409;

  constructor() {
    super('This chat is closed. A new chat opens if someone accepts the request again.');
    this.name = 'ChatClosedError';
  }
}

export interface ChatAccess {
  readonly chatThreadId: string;
  readonly serviceRequestId: string;
  /** The other participant: the one who should receive a push of the caller's message. */
  readonly counterpartUserId: string;
}

interface ThreadRow {
  chat_thread_id: string;
  requester_user_id: string;
  accepted_by_user_id: string;
  released_at: Date | null;
}

export async function resolveChatAccess(
  db: Queryable,
  caller: { readonly tenantId: string; readonly userId: string },
  serviceRequestId: string,
  chatThreadId?: string,
): Promise<ChatAccess> {
  const thread = await db.query<ThreadRow>(
    `SELECT chat_thread_id, requester_user_id, accepted_by_user_id, released_at
       FROM chat_threads
      WHERE tenant_id = $1 AND service_request_id = $2
        AND ($3::uuid IS NULL OR chat_thread_id = $3::uuid)
      ORDER BY (released_at IS NULL) DESC, created_at DESC
      LIMIT 1`,
    [caller.tenantId, serviceRequestId, chatThreadId ?? null],
  );
  const row = thread.rows[0];
  if (row === undefined && chatThreadId !== undefined) throw new ResourceNotVisibleError();
  if (row !== undefined) {
    if (row.requester_user_id === caller.userId) {
      return access(row, serviceRequestId, row.accepted_by_user_id);
    }
    if (row.accepted_by_user_id === caller.userId && row.released_at === null) {
      const stands = await requestHeldInCurrentCycle(
        db,
        caller.tenantId,
        serviceRequestId,
        caller.userId,
      );
      if (!stands) throw new ResourceNotVisibleError();
      return access(row, serviceRequestId, row.requester_user_id);
    }
    throw new ResourceNotVisibleError();
  }

  const requester = await db.query<{ veteran_user_id: string }>(
    `SELECT c.veteran_user_id
       FROM service_requests r
       JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.service_request_id = $2`,
    [caller.tenantId, serviceRequestId],
  );
  if (requester.rows[0]?.veteran_user_id === caller.userId) throw new ChatUnavailableError();
  throw new ResourceNotVisibleError();
}

function access(row: ThreadRow, serviceRequestId: string, counterpartUserId: string): ChatAccess {
  return { chatThreadId: row.chat_thread_id, serviceRequestId, counterpartUserId };
}
