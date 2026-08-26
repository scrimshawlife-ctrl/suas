/**
 * Cloudflare Worker entry. Serves `/app` and `/api/v0` without `listen()`.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §5 (startup validation fails closed before
 *   serving traffic)
 * - SUAS-specs ENVIRONMENT.md §9 (reject an unsafe schema state)
 * - SUAS-specs API.md §2, §6 (existing routes and error body)
 *
 * This isolate is the compute host. It does not authorize PRODUCTION,
 * SPEC-018, real external effects, or a durable job product (D-022).
 */

import { startApp, type StartedApp } from './app.js';
import { ConfigurationError } from './config/index.js';
import { SchemaStateError } from './db/index.js';
import { dispatchToFastify } from './http/dispatch.js';
import { configSourceFromWorkerEnv, type WorkerBindings } from './worker/env.js';

export type { WorkerBindings, WorkerHyperdrive } from './worker/env.js';
export { configSourceFromWorkerEnv } from './worker/env.js';
export { dispatchToFastify } from './http/dispatch.js';

/** Isolate-scoped app. Not request state. */
let isolateApp: Promise<StartedApp> | undefined;

async function startWorkerApp(env: WorkerBindings): Promise<StartedApp> {
  return startApp({
    env: configSourceFromWorkerEnv(env),
    listen: false,
    runtime: 'worker',
  });
}

async function getIsolateApp(env: WorkerBindings): Promise<StartedApp> {
  isolateApp ??= startWorkerApp(env).catch((error: unknown) => {
    isolateApp = undefined;
    throw error;
  });
  return isolateApp;
}

function notReadyResponse(error: unknown): Response {
  const safe =
    error instanceof ConfigurationError || error instanceof SchemaStateError
      ? 'Startup validation failed; this isolate is not serving traffic.'
      : 'Isolate failed startup validation.';
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'isolate_not_ready',
      error_name: error instanceof Error ? error.name : 'unknown',
    }),
  );
  return Response.json({ error: { code: 'NOT_READY', message: safe } }, { status: 503 });
}

function logRequest(request: Request, response: Response, durationMs: number): void {
  const url = new URL(request.url);
  console.log(
    JSON.stringify({
      level: 'info',
      msg: 'request',
      method: request.method,
      path: url.pathname,
      status: response.status,
      duration_ms: durationMs,
      request_id: response.headers.get('x-request-id') ?? undefined,
    }),
  );
}

/**
 * Fetch handler used by wrangler and by tests. Builds the Fastify app once
 * per isolate with `listen: false` and answers through `inject()`.
 */
export async function handleWorkerFetch(request: Request, env: WorkerBindings): Promise<Response> {
  const started = Date.now();
  try {
    const app = await getIsolateApp(env);
    const response = await dispatchToFastify(app.server, request);
    logRequest(request, response, Date.now() - started);
    return response;
  } catch (error) {
    return notReadyResponse(error);
  }
}

/** Test helper: close the cached isolate so suites do not leak pools. */
export async function resetWorkerIsolateForTests(): Promise<void> {
  if (isolateApp === undefined) return;
  const app = await isolateApp.catch(() => undefined);
  isolateApp = undefined;
  if (app !== undefined) await app.close();
}

export default {
  async fetch(request: Request, env: WorkerBindings): Promise<Response> {
    return handleWorkerFetch(request, env);
  },
};
