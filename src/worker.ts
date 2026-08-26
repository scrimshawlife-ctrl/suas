/**
 * Cloudflare Worker entry. Serves `/app` and `/api/v0` via Cloudflare's
 * Node.js HTTP server integration (`cloudflare:node`).
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

import { handleAsNodeRequest } from 'cloudflare:node';
import { env as workerEnv } from 'cloudflare:workers';
import { startApp, type StartedApp } from './app.js';
import { ConfigurationError } from './config/index.js';
import { SchemaStateError } from './db/index.js';
import { configSourceFromWorkerEnv, type WorkerBindings } from './worker/env.js';

export type { WorkerBindings, WorkerHyperdrive } from './worker/env.js';
export { configSourceFromWorkerEnv } from './worker/env.js';

/** Routing key for `cloudflare:node` (not a real TCP port). */
const WORKER_HTTP_PORT = 8787;

/** Isolate-scoped app. Not request state. */
let isolateApp: Promise<StartedApp> | undefined;

async function getIsolateApp(bindings: WorkerBindings): Promise<StartedApp> {
  isolateApp ??= startApp({
    env: configSourceFromWorkerEnv(bindings),
    listen: true,
    listenPort: WORKER_HTTP_PORT,
    runtime: 'worker',
  }).catch((error: unknown) => {
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
  const err = error instanceof Error ? error : undefined;
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'isolate_not_ready',
      error_name: err?.name ?? 'unknown',
      error_message: err?.message?.slice(0, 300),
      error_stack: err?.stack?.split('\n').slice(0, 8),
    }),
  );
  return Response.json({ error: { code: 'NOT_READY', message: safe } }, { status: 503 });
}

/**
 * Production fetch handler: Fastify listen() + Cloudflare Node HTTP bridge.
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      await getIsolateApp(workerEnv as WorkerBindings);
      return await handleAsNodeRequest(WORKER_HTTP_PORT, request);
    } catch (error: unknown) {
      return notReadyResponse(error);
    }
  },
};
