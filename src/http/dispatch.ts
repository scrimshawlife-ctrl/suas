/**
 * Convert a Fetch API Request into a Fastify inject() call and back.
 *
 * Cloudflare Workers have no `net.Server`. Fastify's `listen()` binds a TCP
 * socket and is not available there (nodejs_compat documents `net.Server` as
 * unsupported). Tests already drive this app through `inject()` with
 * `listen: false`; the Worker request path uses the same mechanism.
 *
 * Spec citations:
 * - SUAS-specs API.md §2 (`/api/v0` routes stay on the Fastify server)
 * - SUAS-specs API.md §8 (opaque request correlation; no PII in logs)
 */

import type { FastifyInstance, InjectOptions } from 'fastify';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const INJECT_METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'] as const;

type InjectMethod = (typeof INJECT_METHODS)[number];

function isInjectMethod(method: string): method is InjectMethod {
  return (INJECT_METHODS as readonly string[]).includes(method);
}

function requestHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    headers[key] = value;
  });
  return headers;
}

function headerItemToString(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toUTCString();
  }
  return '';
}

function applyInjectHeaders(headers: Record<string, unknown>, target: Headers): void {
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        target.append(key, headerItemToString(item));
      }
      continue;
    }
    target.set(key, headerItemToString(value));
  }
}

/**
 * Dispatch one Fetch request through a Fastify instance that is not listening.
 */
export async function dispatchToFastify(
  server: FastifyInstance,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  if (!isInjectMethod(method)) {
    return Response.json(
      { error: { code: 'VALIDATION_FAILED', message: 'Unsupported HTTP method.' } },
      { status: 400 },
    );
  }

  const hasBody = method !== 'GET' && method !== 'HEAD';
  const payload = hasBody ? Buffer.from(await request.arrayBuffer()) : undefined;
  const remoteAddress = request.headers.get('cf-connecting-ip') ?? undefined;

  const opts: InjectOptions = {
    method,
    url: `${url.pathname}${url.search}`,
    headers: requestHeaders(request),
    ...(payload !== undefined ? { payload } : {}),
    ...(remoteAddress !== undefined ? { remoteAddress } : {}),
  };

  const result = await server.inject(opts);
  const responseHeaders = new Headers();
  applyInjectHeaders({ ...result.headers }, responseHeaders);

  return new Response(result.rawPayload, {
    status: result.statusCode,
    headers: responseHeaders,
  });
}
