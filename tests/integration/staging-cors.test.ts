/**
 * R11.3: the staging web origin is a valid D-038 allowlist entry in STAGING, and a Bearer
 * preflight from it gets exact-origin CORS headers without credentials.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { tryLoadConfig } from '../../src/config/index.js';
import { validEnv } from '../helpers/env.js';

const WEB_ORIGIN = 'https://staging.suasqrf.com';
const stagingEnv = validEnv({
  SUAS_ENV: 'STAGING',
  SUAS_PUBLIC_SIGN_UP: 'disabled',
  SUAS_ID_VERIFICATION_MODE: 'disabled',
  SUAS_CORS_ALLOWED_ORIGINS: WEB_ORIGIN,
});

let app: StartedApp;
beforeAll(async () => {
  app = await startApp({ env: stagingEnv, listen: false });
});
afterAll(async () => {
  await app.close();
});

describe('STAGING web origin (R11.3)', () => {
  it('parses as the one allowlisted origin', () => {
    const result = tryLoadConfig(stagingEnv);
    expect(result.ok ? result.config.corsAllowedOrigins : result.issues).toEqual([WEB_ORIGIN]);
  });

  it('answers a Bearer preflight to /api/v0 with exact-origin headers and no credentials', async () => {
    const response = await app.server.inject({
      method: 'OPTIONS',
      url: '/api/v0/service-requests',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization, content-type, idempotency-key',
      },
    });
    expect(response.statusCode).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(WEB_ORIGIN);
    expect(response.headers['access-control-allow-headers']).toBe(
      'authorization, content-type, idempotency-key',
    );
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });
});
