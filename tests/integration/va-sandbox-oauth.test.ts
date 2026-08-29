/**
 * D-035 VA sandbox OAuth route integration evidence.
 *
 * SUAS-specs release v0.4.0, RELEASE_MANIFEST-0.4.0.md, D-035 approved
 * plan: disabled configuration is absent/fail-closed; OAuth entry and callback
 * require a session; cancellation and malformed callbacks do not echo input.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../src/config/index.js';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

const vaConfig = {
  SUAS_VA_SANDBOX_OAUTH_ENABLED: 'true',
  SUAS_VA_SANDBOX_OAUTH_CLIENT_ID: 'synthetic-client',
  SUAS_VA_SANDBOX_OAUTH_CLIENT_SECRET: 'synthetic-secret',
  SUAS_VA_SANDBOX_OAUTH_AUTHORIZATION_ENDPOINT: 'https://va.example.invalid/authorize',
  SUAS_VA_SANDBOX_OAUTH_REDIRECT_URI: 'https://suas.example.invalid/auth/va/callback',
  SUAS_VA_SANDBOX_OAUTH_TOKEN_ENDPOINT: 'https://va.example.invalid/token',
  SUAS_VA_SANDBOX_OAUTH_STATUS_ENDPOINT: 'https://va.example.invalid/status',
  SUAS_VA_SANDBOX_OAUTH_ISSUER: 'https://va.example.invalid',
  SUAS_VA_SANDBOX_OAUTH_AUDIENCE: 'synthetic-audience',
  SUAS_VA_SANDBOX_OAUTH_JWKS_JSON: '[]',
} as const;

let app: StartedApp;

async function freshCredential(): Promise<string> {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`va-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  return (await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId: user.userId }))
    .credential;
}

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      ...vaConfig,
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
    }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});
describe('D-035 disabled configuration', () => {
  it('leaves both VA sandbox routes absent when disabled', async () => {
    const disabled = await startApp({
      env: validEnv({ SUAS_MIGRATIONS_MODE: 'validate' }),
      listen: false,
    });
    try {
      for (const url of ['/auth/va/onboarding', '/auth/va/callback']) {
        expect((await disabled.server.inject({ method: 'GET', url })).statusCode).toBe(404);
      }
    } finally {
      await disabled.close();
    }
  });

  it('fails closed when explicitly enabled without the complete configuration', async () => {
    await expect(
      startApp({
        env: validEnv({ SUAS_VA_SANDBOX_OAUTH_ENABLED: 'true' }),
        listen: false,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});

describe('D-035 VA sandbox routes', () => {
  it('requires authentication for onboarding and callback', async () => {
    for (const url of ['/auth/va/onboarding', '/auth/va/callback']) {
      const response = await app.server.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
    }
  });

  it('rejects provider cancellation without reflecting provider input', async () => {
    const auth = await freshCredential();
    const response = await app.server.inject({
      method: 'GET',
      url: '/auth/va/callback?error=access_denied&error_description=secret-provider-detail',
      headers: { authorization: `Bearer ${auth}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: {
        code: 'VA_SANDBOX_CALLBACK_REJECTED',
        message: 'The VA sandbox authorization response could not be accepted.',
      },
    });
    expect(response.body).not.toContain('access_denied');
    expect(response.body).not.toContain('secret-provider-detail');
  });

  it('sanitizes malformed callback input', async () => {
    const auth = await freshCredential();
    const response = await app.server.inject({
      method: 'GET',
      url: '/auth/va/callback?code=<script>synthetic-code</script>&state=not-a-valid-transaction',
      headers: { authorization: `Bearer ${auth}`, cookie: '__Host-suas-va-pkce=bad-cookie' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VA_SANDBOX_CALLBACK_REJECTED' } });
    expect(response.body).not.toContain('<script>');
    expect(response.body).not.toContain('synthetic-code');
    expect(response.body).not.toContain('not-a-valid-transaction');
  });
});
