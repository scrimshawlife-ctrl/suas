/**
 * Registered `/api/v0` routes must match docs/openapi/v0.json.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { listRegisteredApiRoutes } from '../../src/http/server.js';
import { testDatabaseUrl, validEnv } from '../helpers/env.js';

const openApiPath = join(dirname(fileURLToPath(import.meta.url)), '../../docs/openapi/v0.json');

function fastifyToOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/** `METHOD /path` for every operation in docs/openapi/v0.json, sorted. */
function documentedOperations(): string[] {
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
  return [...documented].sort();
}

/** The server's route list as `METHOD /path`, sorted, duplicates kept. */
function registeredOperations(server: StartedApp['server']): string[] {
  return listRegisteredApiRoutes(server)
    .map((route) => `${route.method} ${fastifyToOpenApiPath(route.path)}`)
    .sort();
}

const env = validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl() });

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({ env, listen: false });
});

afterAll(async () => {
  await app.close();
});

describe('OpenAPI /api/v0 drift', () => {
  it('documents every registered route and invents none', () => {
    expect([...new Set(registeredOperations(app.server))]).toEqual(documentedOperations());
  });
});

describe('route list per server', () => {
  // PR #331 review: the list is keyed by FastifyInstance. A second server must not
  // add to the first one's list, and an instance createServer never built lists nothing.
  it('gives each createServer call its own complete list and leaks none to other instances', async () => {
    const second = await startApp({ env, listen: false });
    try {
      const documented = documentedOperations();
      expect(registeredOperations(app.server)).toEqual(documented);
      expect(registeredOperations(second.server)).toEqual(documented);
      expect(listRegisteredApiRoutes(Fastify())).toEqual([]);
    } finally {
      await second.close();
    }
  });
});
