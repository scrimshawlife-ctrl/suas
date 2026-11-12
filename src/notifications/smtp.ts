/**
 * SUAS-owned SMTP send contract (suas-specs #75 R11.2, proposal; not released).
 *
 * One rendered message in, one result class out. The Gmail SMTP adapter and the
 * outside-VPC relay function both speak it, so the job worker never sees SMTP
 * replies or library errors (ARCHITECTURE.md §11; NOTIFICATIONS.md §11).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * - `sent`: the server answered 250 to the message (NOTIFICATIONS.md §6 `SENT`).
 * - `rejected`: a permanent 5xx refusal of the message; a retry cannot help.
 * - `retryable`: a 4xx reply, or the connection failed before any message data went out.
 * - `ambiguous_ack`: the message data started and no final reply came back. The server
 *   may have accepted it, so it is not retried blindly (NOTIFICATIONS.md §5).
 */
export const SMTP_RESULT_CLASSES = ['sent', 'rejected', 'retryable', 'ambiguous_ack'] as const;
export type SmtpResultClass = (typeof SMTP_RESULT_CLASSES)[number];

/** One rendered email. `messageId` is opaque and carries no address or content. */
export interface SmtpMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly messageId: string;
}

export interface SmtpSendResult {
  readonly result: SmtpResultClass;
  /** The SMTP reply code when the server gave one. */
  readonly responseCode?: number;
}

export interface SmtpSender {
  readonly implementation: string;
  send(message: SmtpMessage): Promise<SmtpSendResult>;
}

/**
 * A Message-ID local part derived from the idempotency key. A challenge key can embed
 * the destination address, so it is hashed rather than copied into a mail header.
 */
export function smtpMessageId(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32);
}

/** Wire shape of a relay invocation (snake_case JSON, like the job payloads). */
export const smtpRelayRequestSchema = z
  .object({
    to: z.string().email(),
    subject: z.string().min(1).max(998),
    text: z.string(),
    html: z.string().optional(),
    message_id: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();
export type SmtpRelayRequest = z.infer<typeof smtpRelayRequestSchema>;

export const smtpRelayResponseSchema = z
  .object({
    result: z.enum(SMTP_RESULT_CLASSES),
    response_code: z.number().int().min(200).max(599).optional(),
  })
  .strict();
export type SmtpRelayResponse = z.infer<typeof smtpRelayResponseSchema>;

export function toRelayRequest(message: SmtpMessage): SmtpRelayRequest {
  return {
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html !== undefined ? { html: message.html } : {}),
    message_id: message.messageId,
  };
}

export function fromRelayRequest(request: SmtpRelayRequest): SmtpMessage {
  return {
    to: request.to,
    subject: request.subject,
    text: request.text,
    ...(request.html !== undefined ? { html: request.html } : {}),
    messageId: request.message_id,
  };
}

export function toRelayResponse(result: SmtpSendResult): SmtpRelayResponse {
  return {
    result: result.result,
    ...(result.responseCode !== undefined ? { response_code: result.responseCode } : {}),
  };
}
