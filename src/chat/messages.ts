/**
 * Chat messages: store, read back, page.
 *
 * Plan citation: V1_PROJECT_PLAN.md §4.3 F7; text only (plan §8 #7 leaves images,
 * retention, read receipts and typing indicators undecided). `body` is sensitive
 * free text: nothing here logs it (PRIVACY.md §3).
 */

import { randomUUID } from 'node:crypto';
import {
  decodeTimeIdCursor,
  encodeTimeIdCursor,
  pageSize,
  takePage,
  timestampText,
} from '../db/cursor.js';
import type { Queryable } from '../db/index.js';
import { ChatClosedError } from './access.js';

export const MAX_MESSAGE_LENGTH = 2000;

export interface ChatMessage {
  readonly chatMessageId: string;
  readonly serviceRequestId: string;
  readonly senderUserId: string;
  readonly body: string;
  /** ISO-8601 with microseconds, as stored. */
  readonly createdAt: string;
}

interface MessageRow {
  chat_message_id: string;
  sender_user_id: string;
  body: string;
  created_at: string;
}

const CREATED_AT_TEXT = timestampText('m.created_at');

function toMessage(row: MessageRow, serviceRequestId: string): ChatMessage {
  return {
    chatMessageId: row.chat_message_id,
    serviceRequestId,
    senderUserId: row.sender_user_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

/** Stores a message on a live thread; a thread closed by a release refuses it. */
export async function insertChatMessage(
  db: Queryable,
  input: {
    readonly tenantId: string;
    readonly chatThreadId: string;
    readonly senderUserId: string;
    readonly body: string;
  },
): Promise<string> {
  const chatMessageId = randomUUID();
  const inserted = await db.query(
    `INSERT INTO chat_messages (chat_message_id, tenant_id, chat_thread_id, sender_user_id, body)
     SELECT $1, t.tenant_id, t.chat_thread_id, $4, $5
       FROM chat_threads t
      WHERE t.tenant_id = $2 AND t.chat_thread_id = $3 AND t.released_at IS NULL`,
    [chatMessageId, input.tenantId, input.chatThreadId, input.senderUserId, input.body],
  );
  if ((inserted.rowCount ?? 0) === 0) throw new ChatClosedError();
  return chatMessageId;
}

export async function findChatMessage(
  db: Queryable,
  tenantId: string,
  chatThreadId: string,
  serviceRequestId: string,
  chatMessageId: string,
): Promise<ChatMessage | undefined> {
  const result = await db.query<MessageRow>(
    `SELECT m.chat_message_id, m.sender_user_id, m.body, ${CREATED_AT_TEXT} AS created_at
       FROM chat_messages m
      WHERE m.tenant_id = $1 AND m.chat_thread_id = $2 AND m.chat_message_id = $3`,
    [tenantId, chatThreadId, chatMessageId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toMessage(row, serviceRequestId);
}

export interface ChatMessagePage {
  /** Newest first. */
  readonly messages: readonly ChatMessage[];
  /** Pass back as `cursor` for older messages; absent on the last page. */
  readonly nextCursor: string | undefined;
}

/** Keyset page over (created_at, id), newest first, stable while new messages arrive. */
export async function listChatMessages(
  db: Queryable,
  input: {
    readonly tenantId: string;
    readonly chatThreadId: string;
    readonly serviceRequestId: string;
    readonly limit?: number;
    readonly cursor?: string;
  },
): Promise<ChatMessagePage> {
  const limit = pageSize(input.limit);
  const values: unknown[] = [input.tenantId, input.chatThreadId];
  let cursorCondition = '';
  if (input.cursor !== undefined) {
    const { at, id } = decodeTimeIdCursor(input.cursor);
    values.push(at, id);
    cursorCondition = `AND (m.created_at, m.chat_message_id) < ($3::timestamptz, $4::uuid)`;
  }
  values.push(limit + 1);

  const result = await db.query<MessageRow>(
    `SELECT m.chat_message_id, m.sender_user_id, m.body, ${CREATED_AT_TEXT} AS created_at
       FROM chat_messages m
      WHERE m.tenant_id = $1 AND m.chat_thread_id = $2 ${cursorCondition}
      ORDER BY m.created_at DESC, m.chat_message_id DESC
      LIMIT $${String(values.length)}`,
    values,
  );
  const { rows, nextCursor } = takePage(result.rows, limit, (row) =>
    encodeTimeIdCursor({ at: row.created_at, id: row.chat_message_id }),
  );
  return { messages: rows.map((row) => toMessage(row, input.serviceRequestId)), nextCursor };
}
