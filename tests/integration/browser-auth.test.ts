/** Browser EMAIL OTP evidence for AUTH.md §9.1 and D-004 (spec 0.6.0). */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import type { RecordingChallengeDelivery } from '../../src/auth/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { BROWSER_AUTH_BODY_LIMIT_BYTES } from '../../src/http/routes/ui.js';
import { validEnv } from '../helpers/env.js';

// The released pin is 0.6.0, and the D-038 startup guard refuses a non-empty allowlist
// below 0.7.0 in every environment. Mock only the guard's pin so this file can exercise
// the draft path; SPEC_VERSION and SUAS_SPEC_VERSION stay 0.6.0.
vi.mock('../../src/release/pins.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  CORS_GUARD_SPEC_VERSION: '0.7.0',
}));

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
/** Allowlisted cross-origin frontend (proposed SUAS-specs D-038). */
const ALLOWED_ORIGIN = 'https://app.example.org';
const FORM = 'application/x-www-form-urlencoded';
let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      SUAS_BROWSER_AUTH_MODE: 'email_otp',
      SUAS_BROWSER_TENANT_ID: TENANT_ID,
      SUAS_CORS_ALLOWED_ORIGINS: ALLOWED_ORIGIN,
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
    expect(response.body).toContain('If this email is enrolled');
    expect(response.body).not.toContain('tenant_id');
    expect(delivery().lastFor(email.toLowerCase())?.secret).toMatch(/^\d{6}$/);
  });

  it('rejects a cross-site challenge from a non-allowlisted origin before sending email', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: {
        'content-type': FORM,
        host: 'suas.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, role: 'veteran' }),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('accepts a cross-site challenge from an allowlisted origin and answers with CORS headers', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: {
        'content-type': FORM,
        host: 'suas.example',
        origin: ALLOWED_ORIGIN,
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, role: 'veteran' }),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('If this email is enrolled');
    expect(delivery().lastFor(email.toLowerCase())?.secret).toMatch(/^\d{6}$/);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(String(response.headers.vary)).toContain('Origin');
  });

  it('accepts the Origin: null a browser sends on a same-origin form post', async () => {
    // /app pages use referrer-policy no-referrer, so browsers send `Origin: null`.
    const email = await enrolledEmail();
    const headers = {
      'content-type': FORM,
      host: 'suas.example',
      origin: 'null',
      'sec-fetch-site': 'same-origin',
    };

    const challenge = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers,
      payload: form({ destination: email, role: 'veteran' }),
    });
    expect(challenge.statusCode).toBe(200);

    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers,
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(verified.statusCode).toBe(303);
    expect(verified.headers.location).toBe('/app/home');
  });

  it.each([
    ['Origin: null on a cross-site request', 'null', 'cross-site'],
    ['a sibling same-site origin that is not allowlisted', 'https://sibling.example', 'same-site'],
    ['Origin: null with no Sec-Fetch-Site', 'null', undefined],
    ['a foreign Origin with no Sec-Fetch-Site', 'https://attacker.example', undefined],
  ])('rejects %s', async (_label, origin, fetchSite) => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: {
        'content-type': FORM,
        host: 'suas.example',
        origin,
        ...(fetchSite === undefined ? {} : { 'sec-fetch-site': fetchSite }),
      },
      payload: form({ destination: email, role: 'veteran' }),
    });
    expect(response.statusCode).toBe(403);
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('accepts a same-scheme, same-host Origin with no Sec-Fetch-Site (older browsers)', async () => {
    // inject() is plain http in TEST, so the server's own origin is http://suas.example.
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM, host: 'suas.example', origin: 'http://suas.example' },
      payload: form({ destination: email, role: 'veteran' }),
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a same-host Origin on a different scheme with no Sec-Fetch-Site', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM, host: 'suas.example', origin: 'https://suas.example' },
      payload: form({ destination: email, role: 'veteran' }),
    });
    expect(response.statusCode).toBe(403);
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('rejects oversized challenge bodies before sending email', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        destination: email,
        role: 'veteran',
        padding: 'x'.repeat(BROWSER_AUTH_BODY_LIMIT_BYTES),
      }),
    });

    expect(response.statusCode).toBe(413);
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('rejects JSON challenge bodies before sending email', async () => {
    const email = await enrolledEmail();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': 'application/json' },
      payload: { destination: email, role: 'veteran' },
    });

    expect(response.statusCode).toBe(415);
    expect(response.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('rejects cross-site verification from a non-allowlisted origin without consuming the code', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';

    const rejected = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: {
        'content-type': FORM,
        host: 'suas.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(accepted.statusCode).toBe(303);
  });

  it('sets the session cookie as SameSite=None; Secure; HttpOnly; Path=/app for an allowlisted origin', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';

    const response = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: {
        'content-type': FORM,
        host: 'suas.example',
        origin: ALLOWED_ORIGIN,
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('Path=/app');
  });

  it('rejects oversized verification bodies without consuming a code', async () => {
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
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({
        destination: email,
        role: 'veteran',
        code,
        padding: 'x'.repeat(BROWSER_AUTH_BODY_LIMIT_BYTES),
      }),
    });
    expect(rejected.statusCode).toBe(413);

    const accepted = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(accepted.statusCode).toBe(303);
  });

  it('rejects JSON verification bodies without consuming a code', async () => {
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
      headers: { 'content-type': 'application/json' },
      payload: { destination: email, role: 'veteran', code },
    });
    expect(rejected.statusCode).toBe(415);
    expect(rejected.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });

    const accepted = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
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
    expect(setCookie).toContain('SameSite=None');

    const cookie = setCookie.split(';')[0] ?? '';
    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: { cookie },
    });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Deploy QRF');
  });

  it('applies the origin policy to cookie-authenticated writes', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': FORM },
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
    expect(rejected.statusCode).toBe(403);

    const accepted = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: {
        cookie,
        origin: ALLOWED_ORIGIN,
        host: 'suas.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(accepted.statusCode).toBe(303);
    expect(accepted.headers.location).toBe('/app/home');
  });

  it('rejects a cookie-authenticated write that sends neither Sec-Fetch-Site nor Origin', async () => {
    const email = await enrolledEmail();
    await app.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await app.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';
    const credential = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));

    const noMetadata = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: { cookie },
    });
    expect(noMetadata.statusCode).toBe(403);
    expect(noMetadata.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const noMetadataLogout = await app.server.inject({
      method: 'POST',
      url: '/app/auth/logout',
      headers: { cookie },
    });
    expect(noMetadataLogout.statusCode).toBe(403);

    // A non-browser client on Bearer is unaffected.
    const bearer = await app.server.inject({
      method: 'POST',
      url: '/app/qrf/deploy',
      headers: { authorization: `Bearer ${credential}` },
    });
    expect(bearer.statusCode).toBe(303);

    // The session survived the denied logout.
    const home = await app.server.inject({ method: 'GET', url: '/app/home', headers: { cookie } });
    expect(home.statusCode).toBe(200);
  });

  it('applies the same policy to the /api/v0 sign-in endpoint', async () => {
    const email = await enrolledEmail();
    const json = { 'content-type': 'application/json', host: 'suas.example' };

    const rejectedForm = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      headers: {
        'content-type': FORM,
        host: 'suas.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      },
      payload: form({ destination: email, method: 'EMAIL_OTP' }),
    });
    expect(rejectedForm.statusCode).toBe(403);
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();

    const allowed = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      headers: { ...json, origin: ALLOWED_ORIGIN, 'sec-fetch-site': 'cross-site' },
      payload: { destination: email, method: 'EMAIL_OTP' },
    });
    expect(allowed.statusCode).toBe(202);
    expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    // /api/v0 is Bearer-only: no credentials are advertised.
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();

    const native = await app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      headers: json,
      payload: { destination: email, method: 'EMAIL_OTP' },
    });
    expect(native.statusCode).toBe(202);
  });

  it('accepts a same-origin cookie write that carries Origin: null', async () => {
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
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        host: 'suas.example',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(verified.statusCode).toBe(303);
    const cookie = String(verified.headers['set-cookie']).split(';')[0] ?? '';

    const logout = await app.server.inject({
      method: 'POST',
      url: '/app/auth/logout',
      headers: {
        cookie,
        host: 'suas.example',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
    });
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe('/app');
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
      headers: { cookie, 'sec-fetch-site': 'same-origin', origin: 'null' },
    });
    expect(logout.statusCode).toBe(303);
    expect(logout.headers.location).toBe('/app');
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    expect(String(logout.headers['set-cookie'])).toContain('SameSite=None');
    expect(String(logout.headers['set-cookie'])).toContain('Secure');

    const rejected = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: { cookie },
    });
    expect(rejected.statusCode).toBe(401);
  });
});

describe('HTML sign-in with an empty CORS allowlist (0.6.0 cookie)', () => {
  let strictApp: StartedApp;

  beforeAll(async () => {
    strictApp = await startApp({
      env: validEnv({
        SUAS_MIGRATIONS_MODE: 'apply',
        SUAS_BROWSER_AUTH_MODE: 'email_otp',
        SUAS_BROWSER_TENANT_ID: TENANT_ID,
      }),
      listen: false,
    });
  });

  afterAll(async () => {
    await strictApp.close();
  });

  it('sets and clears the session cookie with SameSite=Strict', async () => {
    const email = syntheticEmail(`browser-strict-${randomUUID().slice(0, 8)}`);
    if (strictApp.pool === undefined) throw new Error('test database absent');
    await createUser(strictApp.pool, { tenantId: TENANT_ID, email, status: 'ACTIVE' });
    const strictDelivery = strictApp.challengeDelivery as RecordingChallengeDelivery;

    await strictApp.server.inject({
      method: 'POST',
      url: '/app/auth/challenges',
      headers: { 'content-type': FORM },
      payload: form({ destination: email, role: 'veteran' }),
    });
    const code = strictDelivery.lastFor(email.toLowerCase())?.secret ?? '';
    const verified = await strictApp.server.inject({
      method: 'POST',
      url: '/app/auth/verify',
      headers: { 'content-type': FORM, 'sec-fetch-site': 'same-origin', origin: 'null' },
      payload: form({ destination: email, role: 'veteran', code }),
    });
    expect(verified.statusCode).toBe(303);
    expect(verified.headers['access-control-allow-origin']).toBeUndefined();
    const setCookie = String(verified.headers['set-cookie']);
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('SameSite=None');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/app');

    const cookie = setCookie.split(';')[0] ?? '';
    const logout = await strictApp.server.inject({
      method: 'POST',
      url: '/app/auth/logout',
      headers: { cookie, 'sec-fetch-site': 'same-origin', origin: 'null' },
    });
    expect(logout.statusCode).toBe(303);
    const cleared = String(logout.headers['set-cookie']);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('SameSite=Strict');
    expect(cleared).not.toContain('SameSite=None');
  });
});
