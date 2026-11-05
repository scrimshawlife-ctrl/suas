/**
 * D-052: STAGING server auth admits only an explicitly provisioned synthetic
 * fixture principal. An existing account and its session are refused otherwise.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/session.js';
import { issueChallenge } from '../../src/auth/challenge.js';
import { PublicSignUpRefusedError } from '../../src/auth/staging-access.js';
import { createUser } from '../../src/identity/users.js';
import { API_PREFIX } from '../../src/release/pins.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

const fixtureEmail = syntheticEmail(`staging-fixture-${randomUUID().slice(0, 8)}`);
const otherEmail = syntheticEmail(`staging-other-${randomUUID().slice(0, 8)}`);

describe('D-052 STAGING fixture principals', () => {
  let app: StartedApp;

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a non-fixture session and allows the provisioned fixture', async () => {
    app = await startApp({
      env: validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_MIGRATIONS_MODE: 'apply',
        SUAS_STAGING_AUTH_EMAILS: fixtureEmail,
        SUAS_PUBLIC_SIGN_UP: 'disabled',
        SUAS_ID_VERIFICATION_MODE: 'disabled',
      }),
      listen: false,
    });
    const pool = app.pool;
    if (pool === undefined) throw new Error('The test app has no database pool.');

    const tenantId = randomUUID();
    const fixture = await createUser(pool, { tenantId, email: fixtureEmail, status: 'ACTIVE' });
    const other = await createUser(pool, { tenantId, email: otherEmail, status: 'ACTIVE' });
    const fixtureSession = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: fixture.userId,
    });
    const otherSession = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: other.userId,
    });

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

    await expect(
      issueChallenge(
        {
          pool,
          sessionSecret: TEST_SESSION_SECRET,
          delivery: app.challengeDelivery,
          stagingAccess: {
            environment: 'STAGING',
            publicSignUp: false,
            fixturePrincipals: [fixtureEmail],
          },
        },
        {
          tenantId,
          destination: otherEmail,
          method: 'EMAIL_OTP',
          allowSignUp: true,
        },
      ),
    ).rejects.toThrow(PublicSignUpRefusedError);
  });
});
