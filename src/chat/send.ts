/**
 * Sending a chat message, and pushing it to the other participant.
 *
 * Plan citation: V1_PROJECT_PLAN.md §2.2 (Chat), §4.3 F7. The message is stored
 * first, in the same transaction as its idempotency record. The push comes after
 * the commit and is best-effort: the client can always list the message over REST,
 * so a push failure must never fail the send. Message text is never logged.
 */

import type { Pool } from 'pg';
import { requestHeldInCurrentCycle } from '../coordination/cases.js';
import { commandScope, fingerprintRequest, runIdempotentCommand } from '../idempotency/index.js';
import type { ConnectionPushPort } from '../realtime/connection-push.js';
import type { ChatAccess } from './access.js';
import { listConnectionIds, removeConnection } from './connections.js';
import { findChatMessage, insertChatMessage, type ChatMessage } from './messages.js';

/** The slice of a Fastify/pino logger this module needs. */
export interface ChatLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface SendChatMessageInput {
  readonly tenantId: string;
  readonly senderUserId: string;
  readonly access: ChatAccess;
  readonly body: string;
  readonly idempotencyKey: string;
}

export interface SendChatMessageResult {
  readonly message: ChatMessage;
  readonly replayed: boolean;
}

export async function sendChatMessage(
  pool: Pool,
  input: SendChatMessageInput,
): Promise<SendChatMessageResult> {
  const { access } = input;
  const run = await runIdempotentCommand(
    pool,
    {
      tenantId: input.tenantId,
      commandScope: commandScope({
        command: 'POST /service-requests/{id}/chat/messages',
        aggregateType: 'ChatThread',
        aggregateId: access.chatThreadId,
        actorId: input.senderUserId,
      }),
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprintRequest({
        chat_thread_id: access.chatThreadId,
        body: input.body,
        actor_id: input.senderUserId,
      }),
    },
    async (tx) => {
      const chatMessageId = await insertChatMessage(tx, {
        tenantId: input.tenantId,
        chatThreadId: access.chatThreadId,
        senderUserId: input.senderUserId,
        body: input.body,
      });
      // Only the id is kept with the idempotency record; the text lives in one place.
      return {
        result: { chat_message_id: chatMessageId },
        aggregateType: 'ChatMessage',
        aggregateId: chatMessageId,
      };
    },
  );

  const chatMessageId = run.result.chat_message_id;
  const message =
    typeof chatMessageId === 'string'
      ? await findChatMessage(
          pool,
          input.tenantId,
          access.chatThreadId,
          access.serviceRequestId,
          chatMessageId,
        )
      : undefined;
  if (message === undefined) throw new Error('Stored chat message could not be read back.');
  return { message, replayed: run.replayed };
}

/** The payload the client receives on its WebSocket for a new message. */
export function pushPayload(message: ChatMessage): string {
  return JSON.stringify({
    type: 'chat.message',
    message: {
      chat_message_id: message.chatMessageId,
      service_request_id: message.serviceRequestId,
      sender_user_id: message.senderUserId,
      body: message.body,
      created_at: message.createdAt,
    },
  });
}

/**
 * Deliver a stored message to the other participant's live connections. Never
 * throws: a gone connection is removed from the registry, and any other failure is
 * logged by connection count and error kind only.
 */
export async function pushToCounterpart(
  deps: {
    readonly pool: Pool;
    readonly push: ConnectionPushPort | undefined;
    readonly log: ChatLogger;
  },
  tenantId: string,
  access: ChatAccess,
  message: ChatMessage,
): Promise<void> {
  if (deps.push === undefined) return;
  const push = deps.push;
  try {
    // DISPATCH.md §14.10: the message goes only to someone who could read it over REST.
    // A helper whose case closed or whose cycle ended keeps the thread id but not access.
    if (
      access.counterpartRole === 'HOLDER' &&
      (access.released === true ||
        !(await requestHeldInCurrentCycle(
          deps.pool,
          tenantId,
          access.serviceRequestId,
          access.counterpartUserId,
        )))
    ) {
      return;
    }
    const connectionIds = await listConnectionIds(deps.pool, tenantId, access.counterpartUserId);
    const payload = pushPayload(message);
    const outcomes = await Promise.allSettled(
      connectionIds.map(async (connectionId) => {
        const outcome = await push.send(connectionId, payload);
        if (outcome === 'gone') await removeConnection(deps.pool, connectionId);
      }),
    );
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected').length;
    if (failed > 0) {
      deps.log.warn({ failed, attempted: connectionIds.length }, 'chat push failed');
    }
  } catch {
    deps.log.warn({}, 'chat push could not look up connections');
  }
}
