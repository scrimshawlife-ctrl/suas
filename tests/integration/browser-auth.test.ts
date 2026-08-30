/** Browser EMAIL OTP evidence for AUTH.md §9.1 and D-004 (spec 0.6.0). */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import type { RecordingChallengeDelivery } from '../../src/auth/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { validEnv } from '../helpers/env.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      SUAS_BROWSER_AUTH_MODE: 'email_otp',
      SUAS_BROWSER_TENANT_ID: TENANT_ID,
    }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

function delivery(): RecordingChallengeDelivery {
  return app.challengeDelivery as RecordingChallengeDelivery;
}

async function enrolledEmail(): Promise<string> {
  const email = syntheticEmail(`browser-${randomUUID().slice(0, 8)}`);
  if (app.pool === undefined) throw new Error('test database absent');
  await createUser(app.pool, { tenantId: TENANT_ID, email, status: 'ACTIVE' });
  return email;
}

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

describe('HTML passwordless sign-in', () => {
  it('renders a real EMAIL OTP form when browser auth is enabled', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app/join?role=veteran' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('action="/app/auth/challenges"');
    expect(response.body).toContain('type="email"');
    expect(response.body).toContain('Send sign-in code');
  });

  it('issues a code without exposing tenant authority in the form', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('If this address is enrolled');
    expect(response.body).not.toContain('tenant_id');
    expect(delivery().lastFor(email.toLowerCase())?.secret).toMatch(/^\d{6}$/);
  });

  it('rejects cross-origin challenge requests before sending email', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: 'suas.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, role: 'veteran' }),
    });

    expect(response.statusCode).toBe(401);
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('rejects cross-origin verification requests before consuming a code', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';

    const rejected = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: 'suas.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(rejected.statusCode).toBe(401);

    const accepted = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(accepted.statusCode).toBe(303);
  });

  it('verifies the code, sets a hardened cookie, and authenticates /app', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';

    const verified = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(verified.statusCode).toBe(303);
    expect(verified.headers.location).toBe('/app/home');
    const setCookie = String(verified.headers['set-cookie']);
    expect(setCookie).toContain('__Secure-suas_session=');
    expect(setCookie).toContain('Path=/app');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');

    const cookie = setCookie.split(';')[0] ?? '';
    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: { cookie },
    });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Deploy QRF');
  });

  it('rejects a cross-origin state-changing request using the browser cookie', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';

    const rejected = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: {
        cookie,
        origin: 'https://attacker.example',
        host: 'suas.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(rejected.statusCode).toBe(401);
  });

  it('revokes the authoritative session and clears the browser cookie on sign out', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';

    const logout = await app.server.inject({
      method: 'POST',
      url: '/app/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe('/app');
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');

    const rejected = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(401);
  });
});
