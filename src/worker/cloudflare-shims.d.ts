/**
 * Ambient types for Cloudflare Worker module imports used by src/worker.ts.
 * These modules exist only in the Workers runtime / wrangler bundle.
 */

declare module 'cloudflare:node' {
  export function handleAsNodeRequest(port: number, request: Request): Response | Promise<Response>;
  export function httpServerHandler(serverOrOptions: unknown): {
    fetch(request: Request): Response | Promise<Response>;
  };
}

declare module 'cloudflare:workers' {
  // Bindings are validated at runtime by configSourceFromWorkerEnv.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const env: any;
}
