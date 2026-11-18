/**
 * Shared test actors (requires PostgreSQL).
 *
 * Pins the two helper rules other suites rely on: `elevate` defaults to `admin` but an
 * explicit `elevate: false` wins, and `keyed` always sends its own idempotency key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { isElevated, resolveSession } from '../../src/auth/index.js';
import { appPool, createPerson, keyed, type Actor } from '../helpers/actors.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

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

async function elevated(actor: Actor): Promise<boolean> {
  const credential = actor.headers.authorization?.replace(/^Bearer /, '') ?? '';
  const resolved = await resolveSession(appPool(app), TEST_SESSION_SECRET, credential);
  if (!resolved.ok) throw new Error(`session did not resolve: ${resolved.reason}`);
  return isElevated(resolved.session);
}

describe('createPerson elevation', () => {
  it('elevates an admin by default', async () => {
    expect(await elevated(await createPerson(app, { label: 'admin', admin: true }))).toBe(true);
  });

  it('does not elevate an admin when elevate is false', async () => {
    const actor = await createPerson(app, { label: 'admin', admin: true, elevate: false });
    expect(await elevated(actor)).toBe(false);
  });

  it('does not elevate a non-admin by default', async () => {
    expect(await elevated(await createPerson(app, { label: 'plain' }))).toBe(false);
  });
});

describe('keyed', () => {
  it('replaces an idempotency key already in the caller headers', () => {
    const who = { headers: { authorization: 'Bearer x', 'idempotency-key': 'stale' } };
    expect(keyed(who)['idempotency-key']).not.toBe('stale');
    expect(keyed(who, 'chosen')).toEqual({
      authorization: 'Bearer x',
      'idempotency-key': 'chosen',
    });
  });
});
