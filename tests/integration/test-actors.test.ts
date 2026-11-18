/**
 * Shared test actors (requires PostgreSQL).
 *
 * Pins the helper rules other suites rely on: `elevate` defaults to `admin` but an
 * explicit `elevate: false` wins, `keyed` always sends its own idempotency key, and
 * `bearer`, `createPerson` and `openRedCase` return what their callers read.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { isElevated, resolveSession, type Session } from '../../src/auth/index.js';
import { findCurrentCase } from '../../src/coordination/index.js';
import { hasConfirmedVeteranStatus, isSuasAdmin } from '../../src/identity/index.js';
import {
  appPool,
  bearer,
  createPerson,
  keyed,
  openRedCase,
  type Actor,
} from '../helpers/actors.js';
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

/** The live session behind a bearer header, read the way the API reads it. */
async function sessionOf(headers: Record<string, string>): Promise<Session> {
  const credential = headers.authorization?.replace(/^Bearer /, '') ?? '';
  const resolved = await resolveSession(appPool(app), TEST_SESSION_SECRET, credential);
  if (!resolved.ok) throw new Error(`session did not resolve: ${resolved.reason}`);
  return resolved.session;
}

async function elevated(actor: Actor): Promise<boolean> {
  return isElevated(await sessionOf(actor.headers));
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

  it('does not elevate a non-admin when elevate is false, and does when it is true', async () => {
    expect(await elevated(await createPerson(app, { label: 'plain', elevate: false }))).toBe(false);
    expect(await elevated(await createPerson(app, { label: 'plain', elevate: true }))).toBe(true);
  });
});

describe('appPool', () => {
  it('refuses an app started without a database', () => {
    expect(() => appPool({ ...app, pool: undefined })).toThrow(
      'The test app has no database pool.',
    );
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

  it("leaves the caller's headers as they were, so a reused actor sends no stale key", () => {
    const who = { headers: { authorization: 'Bearer x' } };
    const sent = keyed(who);
    expect(sent['idempotency-key']).toEqual(expect.any(String));
    expect(who.headers).toEqual({ authorization: 'Bearer x' });
    expect(keyed(who)['idempotency-key']).not.toBe(sent['idempotency-key']);
  });
});

describe('bearer', () => {
  it('signs in the given user, elevated only when asked', async () => {
    const person = await createPerson(app, { label: 'bearer' });
    const plain = await sessionOf(await bearer(app, person.tenantId, person.userId));
    expect(plain).toMatchObject({ tenantId: person.tenantId, userId: person.userId });
    expect(plain.sessionId).not.toBe(person.sessionId);
    expect(isElevated(plain)).toBe(false);
    const stepped = await sessionOf(await bearer(app, person.tenantId, person.userId, true));
    expect(isElevated(stepped)).toBe(true);
  });
});

describe('createPerson', () => {
  it('returns ids and headers for one live session in the tenant it was given', async () => {
    const first = await createPerson(app, { label: 'contract' });
    const actor = await createPerson(app, { label: 'contract', tenantId: first.tenantId });
    expect(actor.tenantId).toBe(first.tenantId);
    expect(actor.userId).not.toBe(first.userId);
    expect(actor.user).toMatchObject({ tenantId: actor.tenantId, userId: actor.userId });
    expect(await sessionOf(actor.headers)).toMatchObject({
      sessionId: actor.sessionId,
      tenantId: actor.tenantId,
      userId: actor.userId,
    });
    expect((await createPerson(app, { label: 'contract' })).tenantId).not.toBe(first.tenantId);
  });

  it('returns the user as the options left it', async () => {
    const pool = appPool(app);
    const plain = await createPerson(app, { label: 'plain', county: 'ALAMEDA' });
    expect(plain.user).toMatchObject({ status: 'ACTIVE', county: 'ALAMEDA' });
    expect(await hasConfirmedVeteranStatus(pool, plain.tenantId, plain.userId)).toBe(false);
    expect(await isSuasAdmin(pool, plain.userId)).toBe(false);

    const full = await createPerson(app, {
      label: 'full',
      verified: true,
      displayName: 'Sam',
      admin: true,
    });
    expect(full.user).toMatchObject({ county: 'SANTA_CLARA', displayName: 'Sam' });
    expect(await hasConfirmedVeteranStatus(pool, full.tenantId, full.userId)).toBe(true);
    expect(await isSuasAdmin(pool, full.userId)).toBe(true);
  });

  // A NULL display_name reads back as undefined: a new sign-up who has not picked one.
  it('leaves the display name unset when none is given', async () => {
    const actor = await createPerson(app, { label: 'unnamed', verified: true });
    expect(actor.user.displayName).toBeUndefined();
  });
});

describe('openRedCase', () => {
  it('opens a RED case for a verified Veteran signed in on a tenant of its own', async () => {
    const a = await openRedCase(app);
    expect(a.veteran).toMatchObject({ tenantId: a.tenantId, county: 'SANTA_CLARA' });
    expect(await hasConfirmedVeteranStatus(a.pool, a.tenantId, a.veteran.userId)).toBe(true);
    expect(await sessionOf(a.headers)).toMatchObject({
      tenantId: a.tenantId,
      userId: a.veteran.userId,
    });
    expect(a.supportCase).toMatchObject({
      tenantId: a.tenantId,
      veteranUserId: a.veteran.userId,
      prioritySignalLevel: 'RED',
    });

    const b = await openRedCase(app);
    expect(b.tenantId).not.toBe(a.tenantId);
    expect(await findCurrentCase(a.pool, a.tenantId, b.veteran.userId)).toBeUndefined();
  });
});
