import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';
import { ApiError } from './errors';
import { createTokenStore } from './token-store';

function setup(respond: (request: Request) => Response) {
  const requests: Request[] = [];
  const store = createTokenStore();
  const onUnauthorized = vi.fn();
  const onMfaRequired = vi.fn();
  const client = createApiClient({
    baseUrl: 'http://localhost',
    tokenStore: store,
    onUnauthorized,
    onMfaRequired,
    newIdempotencyKey: () => 'generated-key',
    fetch: (request) => {
      requests.push(request);
      return Promise.resolve(respond(request));
    },
  });
  return { client, store, requests, onUnauthorized, onMfaRequired };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('token store', () => {
  it('keeps the token in sessionStorage and clears it', () => {
    const store = createTokenStore();
    store.setToken('abc', { mfaElevated: true });
    expect(window.sessionStorage.getItem('suas.session')).toBe('abc');
    expect(createTokenStore().getToken()).toBe('abc');
    expect(createTokenStore().isMfaElevated()).toBe(true);
    store.clear();
    expect(window.sessionStorage.getItem('suas.session')).toBeNull();
    expect(store.getToken()).toBeNull();
    expect(store.isSignedOut()).toBe(false);
  });

  it('remembers a deliberate sign-out until the next sign-in', () => {
    const store = createTokenStore();
    store.setToken('abc');
    store.signOut();
    expect(store.getToken()).toBeNull();
    expect(store.isSignedOut()).toBe(true);
    store.setToken('def');
    expect(store.isSignedOut()).toBe(false);
  });

  it('notifies subscribers on change', () => {
    const store = createTokenStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setToken('abc');
    store.clear();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('api client middleware', () => {
  it('sends the Bearer token when signed in and none when signed out', async () => {
    const { client, store, requests } = setup(() => json(200, {}));
    await client.GET('/api/v0/health');
    expect(requests[0]?.headers.get('Authorization')).toBeNull();
    store.setToken('tok-1');
    await client.GET('/api/v0/health');
    expect(requests[1]?.headers.get('Authorization')).toBe('Bearer tok-1');
  });

  it('adds an Idempotency-Key to writes only, and keeps one the caller passes', async () => {
    const { client, requests } = setup(() => json(200, {}));
    await client.GET('/api/v0/health');
    await client.POST('/api/v0/auth/sessions/commands/logout');
    await client.PUT('/api/v0/veterans/me/county', { body: { county: 'ALAMEDA' } });
    await client.POST('/api/v0/auth/sessions/commands/logout', {
      headers: { 'Idempotency-Key': 'mine' },
    });
    // The generated header type is required; the client makes it optional for callers.
    await client.POST('/api/v0/service-requests', {
      body: { category: 'FOOD', summary: 'Groceries' },
    });
    expect(requests.map((r) => r.headers.get('Idempotency-Key'))).toEqual([
      null,
      'generated-key',
      'generated-key',
      'mine',
      'generated-key',
    ]);
  });

  it('keeps a key passed through the typed header param', async () => {
    const { client, requests } = setup(() => json(200, {}));
    await client.POST('/api/v0/service-requests', {
      body: { category: 'FOOD', summary: 'Groceries' },
      params: { header: { 'Idempotency-Key': 'typed-key' } },
    });
    expect(requests[0]?.headers.get('Idempotency-Key')).toBe('typed-key');
  });

  it('rejects with a typed ApiError built from the error envelope', async () => {
    const { client } = setup(() =>
      json(403, { error: { code: 'VERIFICATION_REQUIRED', message: 'Verify first.' } }),
    );
    const failure = await client.GET('/api/v0/veterans/me').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 403,
      code: 'VERIFICATION_REQUIRED',
      message: 'Verify first.',
    });
  });

  it('still yields an ApiError when the body is not the envelope', async () => {
    const { client } = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const failure = await client.GET('/api/v0/veterans/me').catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 502, code: 'HTTP_502' });
  });

  it('clears the token and redirects on a 401 for a signed-in request', async () => {
    const { client, store, onUnauthorized } = setup(() =>
      json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in again.' } }),
    );
    store.setToken('expired');
    await expect(client.GET('/api/v0/veterans/me')).rejects.toMatchObject({ status: 401 });
    expect(store.getToken()).toBeNull();
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat a wrong sign-in code as an expired session', async () => {
    const { client, store, onUnauthorized } = setup(() =>
      json(401, { error: { code: 'INVALID_CODE', message: 'That code did not work.' } }),
    );
    store.setToken('still-valid');
    await expect(
      client.POST('/api/v0/auth/challenges/commands/verify', {
        body: { destination: 'a@example.invalid', code: '000000' },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CODE' });
    expect(store.getToken()).toBe('still-valid');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not end the session on a wrong MFA response', async () => {
    const { client, store, onUnauthorized } = setup(() =>
      json(401, { error: { code: 'UNAUTHENTICATED', message: 'The MFA response is not valid.' } }),
    );
    store.setToken('still-valid');
    await expect(
      client.POST('/api/v0/auth/mfa/challenges/commands/verify', {
        body: { challenge_id: 'mfa-test-1', response: 'wrong' },
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.getToken()).toBe('still-valid');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('does not redirect on a 401 from logout (sign-out ends on "/" itself)', async () => {
    const { client, store, onUnauthorized } = setup(() =>
      json(401, { error: { code: 'UNAUTHENTICATED', message: 'Gone.' } }),
    );
    store.setToken('expired');
    await expect(client.POST('/api/v0/auth/sessions/commands/logout')).rejects.toMatchObject({
      status: 401,
    });
    expect(onUnauthorized).not.toHaveBeenCalled();
    expect(store.getToken()).toBe('expired');
  });

  it('clears the MFA flag and calls the handler on MFA_REQUIRED, keeping the session', async () => {
    const { client, store, onMfaRequired, onUnauthorized } = setup(() =>
      json(403, { error: { code: 'MFA_REQUIRED', message: 'Confirm it is you.' } }),
    );
    store.setToken('tok', { mfaElevated: true });
    await expect(client.GET('/api/v0/admin/build-info')).rejects.toMatchObject({
      status: 403,
      code: 'MFA_REQUIRED',
    });
    expect(store.isMfaElevated()).toBe(false);
    expect(store.getToken()).toBe('tok');
    expect(onMfaRequired).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});
