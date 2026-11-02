/**
 * Worker fetch helper tests (Node/vitest): inject path + startApp worker rules.
 * Production CF entry is `src/worker.ts` (`handleAsNodeRequest` + listen).
 *
 * SUAS-specs API.md §2, §6; ENVIRONMENT.md §5, §9.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/config/index.js';
import { startApp } from '../../src/app.js';
import { dispatchToFastify } from '../../src/http/dispatch.js';
import type { WorkerBindings } from '../../src/worker/env.js';
import { handleWorkerFetch, resetWorkerIsolateForTests } from '../../src/worker/test-fetch.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

function workerBindings(overrides: Partial<WorkerBindings> = {}): WorkerBindings {
  return {
    HYPERDRIVE: { connectionString: testDatabaseUrl() },
    SUAS_ENV: 'TEST',
    SUAS_SPEC_VERSION: '0.6.0',
    SUAS_RELEASE_MANIFEST: 'RELEASE_MANIFEST-0.6.0.md',
    SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
    SUAS_MIGRATIONS_MODE: 'validate',
    SUAS_SESSION_SECRET: TEST_SESSION_SECRET,
    SUAS_BROWSER_AUTH_MODE: 'disabled',
    SUAS_EMAIL_MODE: 'fake',
    SUAS_SMS_MODE: 'fake',
    SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
    SUAS_SHELTER_ADAPTER_MODE: 'fake',
    SUAS_FOOD_ADAPTER_MODE: 'fake',
    SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
    SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
    SUAS_SAFETY_COPY_MODE: 'placeholder_test_only',
    SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
    ...overrides,
  };
}

beforeAll(async () => {
  // Shared test DB is already at schema 11 from global setup. Worker isolate
  // start uses validate/version-only and must not apply.
  await resetWorkerIsolateForTests();
});

afterAll(async () => {
  await resetWorkerIsolateForTests();
});

describe('dispatchToFastify', () => {
  it('answers a CORS preflight and decorates responses on the Worker dispatch path', async () => {
    const app = await startApp({
      env: validEnv({
        SUAS_MIGRATIONS_MODE: 'validate',
        SUAS_CORS_ALLOWED_ORIGINS: 'https://app.example.org',
      }),
      listen: false,
      runtime: 'worker',
    });
    try {
      const preflight = await dispatchToFastify(
        app.server,
        new Request('http://suas.test/api/v0/cases', {
          method: 'OPTIONS',
          headers: {
            origin: 'https://app.example.org',
            'access-control-request-method': 'POST',
            'access-control-request-headers': 'authorization, idempotency-key',
          },
        }),
      );
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
      expect(preflight.headers.get('access-control-allow-headers')).toBe(
        'authorization, idempotency-key',
      );

      const health = await dispatchToFastify(
        app.server,
        new Request('http://suas.test/api/v0/health', {
          headers: { origin: 'https://app.example.org' },
        }),
      );
      expect(health.status).toBe(200);
      expect(health.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
      expect(health.headers.get('vary')).toContain('Origin');

      const foreign = await dispatchToFastify(
        app.server,
        new Request('http://suas.test/api/v0/auth/challenges', {
          method: 'POST',
          headers: {
            origin: 'https://attacker.example',
            'sec-fetch-site': 'cross-site',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ destination: 'x@example.invalid', method: 'EMAIL_OTP' }),
        }),
      );
      expect(foreign.status).toBe(403);
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('serves liveness and the public /app HTML without listen()', async () => {
    const app = await startApp({
      env: validEnv({ SUAS_MIGRATIONS_MODE: 'validate' }),
      listen: false,
      runtime: 'worker',
    });
    try {
      const health = await dispatchToFastify(
        app.server,
        new Request('http://suas.test/api/v0/health'),
      );
      expect(health.status).toBe(200);
      const healthBody = (await health.json()) as { status: string };
      expect(healthBody.status).toBe('ok');
      expect(health.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9._-]{1,128}$/);

      const landing = await dispatchToFastify(app.server, new Request('http://suas.test/app'));
      expect(landing.status).toBe(200);
      expect(landing.headers.get('content-type')).toMatch(/text\/html/);
      const html = await landing.text();
      expect(html).toContain('Shut Up and Serve');

      const callback = await dispatchToFastify(
        app.server,
        new Request('http://suas.test/auth/va/callback?code=synthetic-code&state=synthetic-state'),
      );
      expect(callback.status).toBe(404);
      const callbackBody = await callback.text();
      expect(callbackBody).not.toContain('synthetic-code');
      expect(callbackBody).not.toContain('synthetic-state');
    } finally {
      await app.close();
    }
  });
});

describe('handleWorkerFetch', () => {
  it('serves /api/v0/health and /app through the isolate fetch handler', async () => {
    const env = workerBindings();
    const health = await handleWorkerFetch(new Request('http://suas.test/api/v0/health'), env);
    expect(health.status).toBe(200);
    expect((await health.json()) as { status: string }).toEqual(
      expect.objectContaining({ status: 'ok' }),
    );

    const landing = await handleWorkerFetch(new Request('http://suas.test/app'), env);
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('Veteran peer support');
  });

  it('returns 503 with the canonical error body when Hyperdrive is missing', async () => {
    await resetWorkerIsolateForTests();
    const response = await handleWorkerFetch(
      new Request('http://suas.test/api/v0/health'),
      workerBindings({ HYPERDRIVE: undefined }),
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('NOT_READY');
    expect(body.error.message).not.toContain(TEST_SESSION_SECRET);
    expect(JSON.stringify(body)).not.toContain('postgresql://');
  });
});

describe('startApp worker runtime', () => {
  it('allows listen with listenPort (cloudflare:node routing key) and refuses apply mode', async () => {
    const app = await startApp({
      env: validEnv({ SUAS_MIGRATIONS_MODE: 'validate' }),
      listen: true,
      listenPort: 18787,
      runtime: 'worker',
    });
    try {
      expect(app.server.server.listening).toBe(true);
    } finally {
      await app.close();
    }

    await expect(
      startApp({
        env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }),
        listen: false,
        runtime: 'worker',
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
