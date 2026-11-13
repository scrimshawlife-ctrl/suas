/**
 * Content-free request and failure logging.
 *
 * Spec citations: SUAS-specs SECURITY.md §2 ("No sensitive data in logs"),
 * ENVIRONMENT.md §6, VETERAN_VERIFICATION.md §2 rule 7 (the OAuth code never reaches logs).
 *
 * A query string can carry an OAuth code or a LOCAL dev destination, and a database
 * error's `detail` quotes row values (`Key (email)=(…)`), so neither is logged.
 */

import type { FastifyRequest } from 'fastify';

/** The request path without its query string or fragment. */
export function pathWithoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

interface RawRequestLike {
  readonly method?: string;
  readonly url?: string;
  readonly host?: string;
  readonly ip?: string;
}

/** Pino `req` serializer: Fastify's default fields, with the query string removed. */
export function serializeRequest(request: RawRequestLike): {
  method?: string;
  url: string;
  host?: string;
  remoteAddress?: string;
} {
  return {
    ...(request.method !== undefined ? { method: request.method } : {}),
    url: pathWithoutQuery(request.url ?? ''),
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.ip !== undefined ? { remoteAddress: request.ip } : {}),
  };
}

/**
 * Pino `err` serializer and the console failure line share this shape: the error's
 * name, its code (a Fastify code or a pg SQLSTATE) and stack frames, never its message,
 * which may quote input, nor any driver field such as `detail`.
 */
export function serializeError(error: unknown): {
  type: string;
  message: string;
  stack: string;
  code?: string;
} {
  const err = error instanceof Error ? error : undefined;
  const code = (error as { code?: unknown } | null)?.code;
  return {
    type: err?.name ?? 'unknown',
    // Pino's error shape requires a message; it is withheld, not the error's own text.
    message: 'withheld',
    // The first stack line repeats the message, so only the frames are kept.
    stack: err?.stack?.split('\n').slice(1, 11).join('\n') ?? '',
    ...(typeof code === 'string' ? { code } : {}),
  };
}

/** One structured line for an unhandled 5xx, usable where pino is off (Worker isolates). */
export function failureLogLine(request: FastifyRequest, error: unknown): string {
  return JSON.stringify({
    level: 'error',
    msg: 'unhandled_request_failure',
    route: request.routeOptions.url ?? pathWithoutQuery(request.url),
    ...serializeError(error),
  });
}
