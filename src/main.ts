/**
 * Process entrypoint.
 *
 * SUAS-specs ENVIRONMENT.md §5: startup validation runs before serving traffic and
 * fails closed. A configuration or schema-state failure exits non-zero with the
 * violated invariants and never degrades into a partially-started process.
 */

import { startApp } from './app.js';
import { installShutdown } from './cli/shutdown.js';

async function main(): Promise<void> {
  const app = await startApp({ env: process.env });
  installShutdown(() => app.close(), {
    onSignal: (signal) => app.server.log.info({ signal }, 'shutting down'),
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
