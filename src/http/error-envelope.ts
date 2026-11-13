/**
 * API.md §6 error bodies for failures that never reach a route handler's own error:
 * request validation, framework router limits, oversized bodies, and malformed HTTP.
 *
 * Every such answer is `{ "error": { "code", "message", "details"? } }` with a short,
 * non-sensitive message. Nothing here echoes the request URL, body or headers.
 */

import type { Socket } from 'node:net';
import { STATUS_CODES } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ZodError } from 'zod';

/** API.md §6: 400 is "validation / malformed request". */
export const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** A transport-level refusal the router or HTTP parser raised before any handler ran. */
const FRAMEWORK_MESSAGES: Readonly<Record<number, string>> = {
  400: 'The request is malformed.',
  413: 'The request body is too large.',
  414: 'The request URL is too long.',
  415: 'The request content type is not supported.',
  431: 'The request headers are too large.',
};

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** Statuses whose envelope code is VALIDATION_FAILED: the request itself is unusable. */
export function isMalformedRequestStatus(status: number): boolean {
  return status in FRAMEWORK_MESSAGES;
}

/** The fixed message for a framework refusal, so a parser's text never reaches the client. */
export function frameworkMessage(status: number): string {
  return FRAMEWORK_MESSAGES[status] ?? 'The request could not be processed.';
}

/**
 * A readable message plus per-field issues for a schema failure. Enum and literal
 * issues get a generic message, since zod's own lists every option and quotes the input.
 */
export function validationErrorBody(error: ZodError) {
  const issues = error.issues.slice(0, 20).map((issue) => ({
    path: issue.path.length === 0 ? '(body)' : issue.path.join('.'),
    code: issue.code,
    message:
      issue.code === 'invalid_enum_value' || issue.code === 'invalid_literal'
        ? 'Invalid value.'
        : issue.message,
  }));
  const first = issues[0];
  const message =
    first === undefined
      ? 'The request is not valid.'
      : `${first.path}: ${first.message}` +
        (issues.length > 1 ? ` (and ${String(issues.length - 1)} more)` : '');
  return errorBody(VALIDATION_FAILED, message, { issues });
}

/**
 * Fastify `frameworkErrors`: a bad URL or an over-long path parameter is a malformed
 * request, the same 400 a malformed id gets from a route (A5-10).
 */
export function handleFrameworkError(
  error: Error & { code?: string },
  _request: FastifyRequest,
  reply: FastifyReply,
): void {
  const malformed = error.code === 'FST_ERR_BAD_URL' || error.code === 'FST_ERR_MAX_PARAM_LENGTH';
  void reply
    .status(malformed ? 400 : 500)
    .send(
      malformed
        ? errorBody(VALIDATION_FAILED, frameworkMessage(400))
        : errorBody('INTERNAL_ERROR', 'Unexpected internal failure.'),
    );
}

/**
 * Node `clientError` handler: the HTTP parser refused the request (for example 431 for
 * oversized headers), so the answer is written straight to the socket in the envelope.
 */
export function handleClientError(error: Error & { code?: string }, socket: Socket): void {
  if (error.code === 'ECONNRESET' || socket.destroyed) return;
  const status =
    error.code === 'HPE_HEADER_OVERFLOW'
      ? 431
      : error.code === 'ERR_HTTP_REQUEST_TIMEOUT'
        ? 408
        : 400;
  const body = JSON.stringify(
    status === 408
      ? errorBody('REQUEST_FAILED', 'The request took too long to arrive.')
      : errorBody(VALIDATION_FAILED, frameworkMessage(status)),
  );
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${String(status)} ${STATUS_CODES[status] ?? ''}\r\n` +
        `Content-Length: ${String(Buffer.byteLength(body))}\r\n` +
        'Content-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n' +
        body,
    );
  }
  socket.destroy(error);
}
