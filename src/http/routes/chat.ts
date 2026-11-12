/**
 * Chat over `/api/v0`: list and send text messages, and issue a WebSocket connect ticket.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 "Peer flow" (chat only between the
 * requester and the person who accepted), §2.2 (Chat), §4.3 F7. Messages travel
 * over REST and live in RDS; the WebSocket only pushes new ones to the other
 * participant. Message text is never logged.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ResourceNotVisibleError } from '../../authz/index.js';
import { authenticate } from '../authenticate.js';
import { pageQuery } from '../cursor.js';
import { readIdempotencyKey } from '../idempotency-header.js';
import {
  issueConnectTicket,
  listChatMessages,
  listChatThreads,
  MAX_MESSAGE_LENGTH,
  pushToCounterpart,
  resolveChatAccess,
  sendChatMessage,
  type ChatMessage,
} from '../../chat/index.js';
import type { ConnectionPushPort } from '../../realtime/connection-push.js';
import { API_PREFIX } from '../../release/pins.js';

export interface ChatRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  /** Absent when realtime push is not configured; messages still work over REST. */
  readonly push: ConnectionPushPort | undefined;
}

/** Realtime push is not configured, so there is nothing to connect to. */
class ChatRealtimeUnavailableError extends Error {
  readonly code = 'CHAT_REALTIME_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor() {
    super('Live chat updates are not available. Messages can still be sent and listed.');
    this.name = 'ChatRealtimeUnavailableError';
  }
}

const idParams = z.object({ id: z.string().uuid() });

const listQuery = pageQuery.extend({
  /** A chat_thread_id of this request; absent means the live thread. */
  thread: z.string().uuid().optional(),
});

/** POST may name the live thread; naming any other thread is refused like an unknown id. */
const sendQuery = z.object({ thread: z.string().uuid().optional() });

const sendBody = z.object({
  body: z
    .string()
    .max(MAX_MESSAGE_LENGTH)
    .transform((text) => text.trim())
    .refine((text) => text.length > 0, { message: 'body must not be empty' }),
});

function publicMessage(message: ChatMessage) {
  return {
    chat_message_id: message.chatMessageId,
    service_request_id: message.serviceRequestId,
    sender_user_id: message.senderUserId,
    body: message.body,
    created_at: message.createdAt,
  };
}

export function registerChatRoutes(app: FastifyInstance, deps: ChatRouteDeps): void {
  /** The caller's own threads (as requester or accepter), newest activity first. */
  app.get(`${API_PREFIX}/chat/threads`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const query = pageQuery.parse(request.query);
    const page = await listChatThreads(deps.pool, context.tenantId, context.userId, query);
    return {
      threads: page.threads.map((thread) => ({
        chat_thread_id: thread.chatThreadId,
        service_request_id: thread.serviceRequestId,
        category: thread.category,
        summary: thread.summary,
        counterpart_display_name: thread.counterpartDisplayName,
        last_message_body: thread.lastMessageBody,
        last_message_at: thread.lastMessageAt?.toISOString() ?? null,
        accepted_at: thread.acceptedAt.toISOString(),
        released_at: thread.releasedAt?.toISOString() ?? null,
        closed: thread.closed,
        role: thread.role,
        last_message_from_me: thread.lastMessageFromMe,
      })),
      next_cursor: page.nextCursor ?? null,
    };
  });

  app.get(`${API_PREFIX}/service-requests/:id/chat/messages`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const query = listQuery.parse(request.query);
    const access = await resolveChatAccess(deps.pool, context, id, query.thread);
    const page = await listChatMessages(deps.pool, {
      tenantId: context.tenantId,
      chatThreadId: access.chatThreadId,
      serviceRequestId: id,
      limit: query.limit,
      ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
    });
    return {
      messages: page.messages.map(publicMessage),
      next_cursor: page.nextCursor ?? null,
    };
  });

  app.post(`${API_PREFIX}/service-requests/:id/chat/messages`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const { id } = idParams.parse(request.params);
    const { body } = sendBody.parse(request.body);
    const { thread } = sendQuery.parse(request.query);
    const idempotencyKey = readIdempotencyKey(request.headers['idempotency-key']);
    const access = await resolveChatAccess(deps.pool, context, id, thread);
    // An earlier (released) thread is read-only, and a message never lands on a thread the
    // caller did not name: the same 404 as an unknown or foreign thread id (D-061, Q11).
    if (thread !== undefined && access.released === true) throw new ResourceNotVisibleError();

    const sent = await sendChatMessage(deps.pool, {
      tenantId: context.tenantId,
      senderUserId: context.userId,
      access,
      body,
      idempotencyKey,
    });

    if (!sent.replayed) {
      await pushToCounterpart(
        { pool: deps.pool, push: deps.push, log: request.log },
        context.tenantId,
        access,
        sent.message,
      );
    }
    return reply.status(sent.replayed ? 200 : 201).send({
      ...publicMessage(sent.message),
      replayed: sent.replayed,
    });
  });

  app.post(`${API_PREFIX}/chat/connect-tickets`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    if (deps.push === undefined) throw new ChatRealtimeUnavailableError();
    const issued = await issueConnectTicket(deps.pool, {
      tenantId: context.tenantId,
      userId: context.userId,
      sessionId: context.session.sessionId,
    });
    return reply.status(201).send({
      ticket: issued.ticket,
      expires_at: issued.expiresAt.toISOString(),
      websocket_url: deps.push.connectUrl(),
    });
  });
}
