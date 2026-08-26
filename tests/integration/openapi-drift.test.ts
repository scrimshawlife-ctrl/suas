/**
 * Registered `/api/v0` routes must match docs/openapi/v0.json.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { listRegisteredApiRoutes } from '../../src/http/server.js';
import { testDatabaseUrl, validEnv } from '../helpers/env.js';

const openApiPath = join(dirname(fileURLToPath(import.meta.url)), '../../docs/openapi/v0.json');

function fastifyToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl() }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

describe('OpenAPI /api/v0 drift', () => {
  it('documents every registered route and invents none', () => {
    const document = JSON.parse(readFileSync(openApiPath, 'utf8')) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const documented = new Set<string>();
    for (const [path, methods] of Object.entries(document.paths)) {
      for (const method of Object.keys(methods)) {
        if (method.startsWith('x-') || method === 'parameters') continue;
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }

    const registered = new Set(
      listRegisteredApiRoutes().map(
        (route) => `${route.method} ${fastifyToOpenApiPath(route.path)}`,
      ),
    );

    expect([...registered].sort()).toEqual([...documented].sort());
  });
});
