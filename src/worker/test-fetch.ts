/**
 * Node/vitest Worker fetch helper using Fastify inject() (listen: false).
 *
 * Production Cloudflare entry is `src/worker.ts` and uses `cloudflare:node`.
 * Tests must not import that file (it pulls Workers-only modules).
 */

import { startApp, type StartedApp } from '../app.js';
import { ConfigurationError } from '../config/index.js';
import { SchemaStateError } from '../db/index.js';
import { dispatchToFastify } from '../http/dispatch.js';
import { configSourceFromWorkerEnv, type WorkerBindings } from './env.js';

let isolateApp: Promise<StartedApp> | undefined;

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
    }),
  );
  return Response.json({ error: { code: 'NOT_READY', message: safe } }, { status: 503 });
}

async function getIsolateApp(env: WorkerBindings): Promise<StartedApp> {
  isolateApp ??= startApp({
    env: configSourceFromWorkerEnv(env),
    listen: false,
    runtime: 'worker',
  }).catch((error: unknown) => {
    isolateApp = undefined;
    throw error;
  });
  return isolateApp;
}

export async function handleWorkerFetch(request: Request, env: WorkerBindings): Promise<Response> {
  const started = Date.now();
  try {
    const app = await getIsolateApp(env);
    const response = await dispatchToFastify(app.server, request);
    console.log(
      JSON.stringify({
        level: 'info',
        msg: 'request',
        method: request.method,
        path: new URL(request.url).pathname,
        status: response.status,
        duration_ms: Date.now() - started,
        request_id: response.headers.get('x-request-id') ?? undefined,
      }),
    );
    return response;
  } catch (error: unknown) {
    return notReadyResponse(error);
  }
}

export async function resetWorkerIsolateForTests(): Promise<void> {
  if (isolateApp !== undefined) {
    try {
      const app = await isolateApp;
      await app.close();
    } catch {
      // Startup failed; nothing to close.
    }
  }
  isolateApp = undefined;
}
