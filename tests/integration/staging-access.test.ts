/**
 * D-052: STAGING server auth admits only an explicit (tenant id, user id) pair.
 * An empty registry admits nobody. Email alone, including the demo account and
 * a second tenant, is not admission.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { issueChallenge } from '../../src/auth/challenge.js';
import { RecordingChallengeDelivery } from '../../src/auth/delivery.js';
import { verifyAndCreateSession } from '../../src/auth/login.js';
import { createSession } from '../../src/auth/session.js';
import {
  assertPublicSignUpPermitted,
  PublicSignUpRefusedError,
  type StagingAccess,
} from '../../src/auth/staging-access.js';
import { BROWSER_SESSION_COOKIE } from '../../src/http/authenticate.js';
import { createIdVerificationPort } from '../../src/identity/id-verification.js';
import { createUser } from '../../src/identity/users.js';
import { API_PREFIX } from '../../src/release/pins.js';
import { DEMO_FIXED_CODE_DESTINATION } from '../../src/auth/demo-fixed-code.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

interface EffectCounts {
  readonly users: string;
  readonly challenges: string;
  readonly sessions: string;
  readonly deliveries: string;
}

function deliveriesOf(app: StartedApp): RecordingChallengeDelivery {
  const delivery = app.challengeDelivery;
  if (!(delivery instanceof RecordingChallengeDelivery)) {
    throw new Error('The test app is not recording challenge delivery.');
  }
  return delivery;
}

async function effectCounts(pool: Pool, app: StartedApp): Promise<EffectCounts> {
  const users = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM users');
  const challenges = await pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM auth_challenges',
  );
  const sessions = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM sessions');
  return {
    users: users.rows[0]?.n ?? '',
    challenges: challenges.rows[0]?.n ?? '',
    sessions: sessions.rows[0]?.n ?? '',
    deliveries: String(deliveriesOf(app).delivered().length),
  };
}

async function stagingApp(
  registry: readonly { tenantId: string; userId: string }[],
  demo: 'enabled' | 'disabled' | undefined = undefined,
): Promise<StartedApp> {
  return startApp({
    env: validEnv({
      SUAS_ENV: 'STAGING',
      SUAS_MIGRATIONS_MODE: 'apply',
      SUAS_PUBLIC_SIGN_UP: 'disabled',
      SUAS_ID_VERIFICATION_MODE: 'disabled',
      SUAS_STAGING_FIXTURE_REGISTRY: registry
        .map((pair) => `${pair.tenantId}:${pair.userId}`)
        .join(','),
      ...(demo === undefined ? {} : { SUAS_DEMO_FIXED_CODE: demo }),
    }),
    listen: false,
  });
}

describe('D-052 STAGING fixture registry', () => {
  it('allows the listed pair and refuses another account', async () => {
    const tenantId = randomUUID();
    const fixtureUserId = randomUUID();
    const email = syntheticEmail(`staging-fixture-${fixtureUserId.slice(0, 8)}`);
    const otherEmail = syntheticEmail(`staging-other-${randomUUID().slice(0, 8)}`);
    const app = await stagingApp([{ tenantId, userId: fixtureUserId }]);
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      const fixture = await createUser(pool, {
        userId: fixtureUserId,
        tenantId,
        email,
        status: 'ACTIVE',
      });
      const other = await createUser(pool, { tenantId, email: otherEmail, status: 'ACTIVE' });
      const fixtureSession = await createSession(pool, TEST_SESSION_SECRET, {
        tenantId,
        userId: fixture.userId,
      });
      const otherSession = await createSession(pool, TEST_SESSION_SECRET, {
        tenantId,
        userId: other.userId,
      });
      const before = await effectCounts(pool, app);

      const allowed = await app.server.inject({
        method: 'GET',
        url: `${API_PREFIX}/veterans/me`,
        headers: { authorization: `Bearer ${fixtureSession.credential}` },
      });
      expect(allowed.statusCode).toBe(200);

      const refused = await app.server.inject({
        method: 'GET',
        url: `${API_PREFIX}/veterans/me`,
        headers: { authorization: `Bearer ${otherSession.credential}` },
      });
      expect(refused.statusCode).toBe(401);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('refuses runtime fake ID and public sign-up on STAGING and PRODUCTION', async () => {
    const app = await stagingApp([]);
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      const before = await effectCounts(pool, app);
      const base = app.config;
      const fakeId = { ...base.idVerification, mode: 'fake' as const };
      expect(() =>
        createIdVerificationPort({ ...base, environment: 'STAGING', idVerification: fakeId }),
      ).toThrow(/refused outside LOCAL and TEST/);
      expect(() =>
        createIdVerificationPort({ ...base, environment: 'PRODUCTION', idVerification: fakeId }),
      ).toThrow(/refused outside LOCAL and TEST/);
      const empty: StagingAccess = {
        environment: 'STAGING',
        publicSignUp: true,
        fixturePrincipals: [],
      };
      expect(() => assertPublicSignUpPermitted(empty)).toThrow(PublicSignUpRefusedError);
      expect(() => assertPublicSignUpPermitted({ ...empty, environment: 'PRODUCTION' })).toThrow(
        PublicSignUpRefusedError,
      );
      await expect(
        issueChallenge(
          {
            pool,
            sessionSecret: TEST_SESSION_SECRET,
            delivery: app.challengeDelivery,
            stagingAccess: empty,
          },
          {
            tenantId: randomUUID(),
            destination: syntheticEmail('signup-refused'),
            method: 'EMAIL_OTP',
            allowSignUp: true,
          },
        ),
      ).rejects.toThrow(PublicSignUpRefusedError);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('admits nobody when the registry is empty, with demo mode on and off', async () => {
    for (const demo of ['enabled', 'disabled'] as const) {
      const app = await stagingApp([], demo);
      try {
        const pool = app.pool;
        if (pool === undefined) throw new Error('The test app has no database pool.');
        const tenantId = randomUUID();
        const user = await createUser(pool, {
          tenantId,
          email:
            demo === 'enabled'
              ? DEMO_FIXED_CODE_DESTINATION
              : syntheticEmail(`empty-${tenantId.slice(0, 8)}`),
          status: 'ACTIVE',
        });
        const session = await createSession(pool, TEST_SESSION_SECRET, {
          tenantId,
          userId: user.userId,
        });
        const before = await effectCounts(pool, app);
        const refused = await app.server.inject({
          method: 'GET',
          url: `${API_PREFIX}/veterans/me`,
          headers: { authorization: `Bearer ${session.credential}` },
        });
        expect(refused.statusCode).toBe(401);
        expect(await effectCounts(pool, app)).toEqual(before);
      } finally {
        await app.close();
      }
    }
  });

  it('refuses a second tenant that reuses a fixture email', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const email = syntheticEmail(`shared-${userId.slice(0, 8)}`);
    const app = await stagingApp([{ tenantId, userId }]);
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      await createUser(pool, { userId, tenantId, email, status: 'ACTIVE' });
      const other = await createUser(pool, {
        tenantId: randomUUID(),
        email,
        status: 'ACTIVE',
      });
      const session = await createSession(pool, TEST_SESSION_SECRET, {
        tenantId: other.tenantId,
        userId: other.userId,
      });
      const before = await effectCounts(pool, app);
      const refused = await app.server.inject({
        method: 'GET',
        url: `${API_PREFIX}/veterans/me`,
        headers: { authorization: `Bearer ${session.credential}` },
      });
      expect(refused.statusCode).toBe(401);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('refuses API bearer and browser cookie requests for a non-admitted session', async () => {
    const app = await stagingApp([]);
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      const tenantId = randomUUID();
      const user = await createUser(pool, {
        tenantId,
        email: syntheticEmail(`cookie-${tenantId.slice(0, 8)}`),
        status: 'ACTIVE',
      });
      const session = await createSession(pool, TEST_SESSION_SECRET, {
        tenantId,
        userId: user.userId,
      });
      const before = await effectCounts(pool, app);
      const bearer = await app.server.inject({
        method: 'GET',
        url: `${API_PREFIX}/veterans/me`,
        headers: { authorization: `Bearer ${session.credential}` },
      });
      const cookie = await app.server.inject({
        method: 'GET',
        url: '/app/notifications',
        headers: {
          cookie: `${BROWSER_SESSION_COOKIE}=${encodeURIComponent(session.credential)}`,
        },
      });
      expect(bearer.statusCode).toBe(401);
      expect(cookie.statusCode).toBe(401);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('refuses an API challenge for a non-admitted account and creates nothing', async () => {
    const app = await stagingApp([]);
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      const tenantId = randomUUID();
      const email = syntheticEmail(`api-challenge-${tenantId.slice(0, 8)}`);
      await createUser(pool, { tenantId, email, status: 'ACTIVE' });
      const before = await effectCounts(pool, app);
      const response = await app.server.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/challenges`,
        payload: { destination: email, method: 'EMAIL_OTP', tenant_id: tenantId },
      });
      expect(response.statusCode).toBe(202);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('refuses a UI challenge for a non-admitted account and creates nothing', async () => {
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const app = await startApp({
      env: validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_MIGRATIONS_MODE: 'apply',
        SUAS_PUBLIC_SIGN_UP: 'disabled',
        SUAS_ID_VERIFICATION_MODE: 'disabled',
        SUAS_BROWSER_AUTH_MODE: 'email_otp',
        SUAS_BROWSER_TENANT_ID: tenantId,
      }),
      listen: false,
    });
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      const email = syntheticEmail(`ui-challenge-${randomUUID().slice(0, 8)}`);
      await createUser(pool, { tenantId, email, status: 'ACTIVE' });
      const before = await effectCounts(pool, app);
      const response = await app.server.inject({
        method: 'POST',
        url: '/app/auth/challenges',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ destination: email, role: 'veteran' }).toString(),
      });
      expect(response.statusCode).toBe(200);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it.each(['STAGING', 'PRODUCTION'] as const)(
    'refuses public sign-up through issueChallenge on %s and creates nothing',
    async (environment) => {
      const app = await stagingApp([]);
      try {
        const pool = app.pool;
        if (pool === undefined) throw new Error('The test app has no database pool.');
        const before = await effectCounts(pool, app);
        await expect(
          issueChallenge(
            {
              pool,
              sessionSecret: TEST_SESSION_SECRET,
              delivery: app.challengeDelivery,
              stagingAccess: { environment, publicSignUp: true, fixturePrincipals: [] },
            },
            {
              tenantId: randomUUID(),
              destination: syntheticEmail(`signup-${environment.toLowerCase()}`),
              method: 'EMAIL_OTP',
              allowSignUp: true,
            },
          ),
        ).rejects.toThrow(PublicSignUpRefusedError);
        expect(await effectCounts(pool, app)).toEqual(before);
      } finally {
        await app.close();
      }
    },
  );

  it('refuses a previously issued challenge after the principal is not admitted', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const email = syntheticEmail(`challenge-${userId.slice(0, 8)}`);
    const app = await stagingApp([{ tenantId, userId }]);
    try {
      const pool = app.pool;
      if (pool === undefined) throw new Error('The test app has no database pool.');
      await createUser(pool, { userId, tenantId, email, status: 'ACTIVE' });
      await issueChallenge(
        {
          pool,
          sessionSecret: TEST_SESSION_SECRET,
          delivery: app.challengeDelivery,
          stagingAccess: {
            environment: 'STAGING',
            publicSignUp: false,
            fixturePrincipals: [{ tenantId, userId }],
          },
        },
        { tenantId, destination: email, method: 'EMAIL_OTP' },
      );
      const secret = deliveriesOf(app).lastFor(email)?.secret;
      expect(secret).toBeDefined();
      const before = await effectCounts(pool, app);
      await expect(
        verifyAndCreateSession(
          {
            pool,
            sessionSecret: TEST_SESSION_SECRET,
            delivery: app.challengeDelivery,
            stagingAccess: { environment: 'STAGING', publicSignUp: false, fixturePrincipals: [] },
          },
          { tenantId, destination: email, code: secret ?? '' },
        ),
      ).rejects.toThrow(/invalid or has expired/);
      expect(await effectCounts(pool, app)).toEqual(before);
    } finally {
      await app.close();
    }
  });

  it('denies an old session once that pair is removed from the registry', async () => {
    const tenantId = randomUUID();
    const userId = randomUUID();
    const email = syntheticEmail(`removed-${userId.slice(0, 8)}`);
    const admitted = await stagingApp([{ tenantId, userId }]);
    const removed = await stagingApp([]);
    try {
      const pool = admitted.pool;
      if (pool === undefined || removed.pool === undefined) {
        throw new Error('The test app has no database pool.');
      }
      await createUser(pool, { userId, tenantId, email, status: 'ACTIVE' });
      const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId });
      const allowed = await admitted.server.inject({
        method: 'GET',
        url: `${API_PREFIX}/veterans/me`,
        headers: { authorization: `Bearer ${session.credential}` },
      });
      expect(allowed.statusCode).toBe(200);
      const before = await effectCounts(removed.pool, removed);
      const denied = await removed.server.inject({
        method: 'GET',
        url: `${API_PREFIX}/veterans/me`,
        headers: { authorization: `Bearer ${session.credential}` },
      });
      expect(denied.statusCode).toBe(401);
      expect(await effectCounts(removed.pool, removed)).toEqual(before);
    } finally {
      await admitted.close();
      await removed.close();
    }
  });
});
