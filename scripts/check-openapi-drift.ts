/**
 * Fail when registered `/api/v0` routes and docs/openapi/v0.json disagree.
 *
 * Fastify uses `:id` path params; OpenAPI uses `{id}`. Comparison is on
 * method + normalized path.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../src/app.js';
import { listRegisteredApiRoutes } from '../src/http/server.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../tests/helpers/env.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const openApiPath = join(root, 'docs/openapi/v0.json');

function openApiKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function fastifyToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

function documentedRoutes(): Set<string> {
  const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const keys = new Set<string>();
  for (const [path, methods] of Object.entries(document.paths ?? {})) {
    for (const method of Object.keys(methods)) {
      if (method.startsWith('x-') || method === 'parameters') continue;
      keys.add(openApiKey(method, path));
    }
  }
  return keys;
}

async function main(): Promise<void> {
  const documented = documentedRoutes();
  const app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_SESSION_SECRET: TEST_SESSION_SECRET,
    }),
    listen: false,
  });
  try {
    const registered = new Set(
      listRegisteredApiRoutes().map((route) =>
        openApiKey(route.method, fastifyToOpenApiPath(route.path)),
      ),
    );

    const missingInOpenApi = [...registered].filter((key) => !documented.has(key)).sort();
    const extraInOpenApi = [...documented].filter((key) => !registered.has(key)).sort();

    if (missingInOpenApi.length === 0 && extraInOpenApi.length === 0) {
      console.log(`openapi drift check ok: ${registered.size} /api/v0 routes match ${openApiPath}`);
      return;
    }

    console.error('OpenAPI route/schema drift detected:');
    if (missingInOpenApi.length > 0) {
      console.error('  registered but missing from OpenAPI:');
      for (const key of missingInOpenApi) console.error(`    - ${key}`);
    }
    if (extraInOpenApi.length > 0) {
      console.error('  documented in OpenAPI but not registered:');
      for (const key of extraInOpenApi) console.error(`    - ${key}`);
    }
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
