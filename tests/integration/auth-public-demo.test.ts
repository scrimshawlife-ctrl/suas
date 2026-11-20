/**
 * R16.1–R16.3 (contributor proposal, not released): STAGING public demo sign-up. Anyone may sign
 * up after the demo acknowledgement, a shared daily cap bounds new-address sends without
 * changing the answer (D-056), and registered fixture users keep working.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { issueChallenge } from '../../src/auth/challenge.js';
import { SIGN_UP_DAILY_CAP } from '../../src/auth/constants.js';
import { RecordingChallengeDelivery } from '../../src/auth/delivery.js';
import { stagingAccessFromConfig } from '../../src/auth/staging-access.js';
import { createUser } from '../../src/identity/users.js';
import { API_PREFIX } from '../../src/release/pins.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { appPool } from '../helpers/actors.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

const SIGN_UP_TENANT = randomUUID();
const FIXTURE_USER = randomUUID();
const FIXTURE_EMAIL = syntheticEmail(`demo-fixture-${FIXTURE_USER.slice(0, 8)}`).toLowerCase();

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_ENV: 'STAGING',
      SUAS_MIGRATIONS_MODE: 'apply',
      SUAS_ID_VERIFICATION_MODE: 'disabled',
      SUAS_PUBLIC_DEMO: 'enabled',
      SUAS_BROWSER_TENANT_ID: SIGN_UP_TENANT,
      SUAS_STAGING_FIXTURE_REGISTRY: `${SIGN_UP_TENANT}:${FIXTURE_USER}`,
    }),
    listen: false,
  });
  await createUser(appPool(app), {
    userId: FIXTURE_USER,
    tenantId: SIGN_UP_TENANT,
    email: FIXTURE_EMAIL,
    status: 'ACTIVE',
  });
});

afterAll(async () => {
  await app.close();
});

// The daily counter is one shared row in the TEST database; each test starts from zero.
beforeEach(async () => {
  await appPool(app).query(`DELETE FROM auth_rate_limits WHERE bucket = 'auth.signup.daily'`);
});

function deliveries(): RecordingChallengeDelivery {
  const delivery = app.challengeDelivery;
  if (!(delivery instanceof RecordingChallengeDelivery)) throw new Error('Not recording.');
  return delivery;
}

const newAddress = () => syntheticEmail(`demo-new-${randomUUID().slice(0, 8)}`).toLowerCase();

function issue(destination: string, extra: Record<string, unknown> = {}) {
  return app.server.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/challenges`,
    payload: { destination, method: 'EMAIL_OTP', ...extra },
  });
}

/** issueChallenge as the route calls it, with a daily cap of one. */
function issueCapped(destination: string) {
  return issueChallenge(
    {
      pool: appPool(app),
      sessionSecret: TEST_SESSION_SECRET,
      delivery: deliveries(),
      stagingAccess: stagingAccessFromConfig(app.config),
      signUpDailyCap: 1,
    },
    { tenantId: SIGN_UP_TENANT, destination, method: 'EMAIL_OTP', allowSignUp: true },
  );
}

describe('STAGING public demo sign-up', () => {
  it('sends a code to a new address and verifying it creates an ACTIVE user', async () => {
    const email = newAddress();
    const issued = await issue(email, { demo_acknowledged: true });
    expect(issued.statusCode).toBe(202);
    const code = deliveries().lastFor(email)?.secret ?? '';
    expect(code).not.toBe('');

    const verified = await app.server.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/challenges/commands/verify`,
      payload: { destination: email, code },
    });
    expect(verified.statusCode).toBe(201);
    const user = await appPool(app).query<{ user_id: string; status: string }>(
      'SELECT user_id, status FROM users WHERE tenant_id = $1 AND lower(email) = $2',
      [SIGN_UP_TENANT, email],
    );
    expect(user.rows[0]?.status).toBe('ACTIVE');
    const audit = await appPool(app).query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE event_type = 'USER_SELF_SIGNED_UP' AND target_id = $1`,
      [user.rows[0]?.user_id],
    );
    expect(audit.rows[0]?.payload).toEqual({ method: 'EMAIL_OTP', demo_acknowledged: true });
  });

  it('answers 400 alike for a known and a new address without the acknowledgement', async () => {
    const sentBefore = deliveries().delivered().length;
    const known = await issue(FIXTURE_EMAIL);
    const unknown = await issue(newAddress(), { demo_acknowledged: false });
    expect(known.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(400);
    expect(known.json()).toEqual(unknown.json());
    expect(known.json().error.code).toBe('VALIDATION_FAILED');
    expect(deliveries().delivered().length).toBe(sentBefore);
  });

  it('counts a known address against the cap too, so the counter reveals nothing', async () => {
    expect((await issueCapped(FIXTURE_EMAIL)).issued).toBe(true);
    const fresh = newAddress();
    expect((await issueCapped(fresh)).issued).toBe(false);
    expect(deliveries().lastFor(fresh)).toBeUndefined();
  });

  it('over the daily cap answers a new address the same and sends nothing, but not a known one', async () => {
    expect((await issueCapped(newAddress())).issued).toBe(true);

    const over = newAddress();
    expect((await issueCapped(over)).issued).toBe(false);
    expect(deliveries().lastFor(over)).toBeUndefined();
    const row = await appPool(app).query<{ auth_challenge_id: string; status: string }>(
      'SELECT auth_challenge_id, status FROM auth_challenges WHERE destination = $1',
      [over],
    );
    expect(row.rows.map((r) => r.status)).toEqual(['REVOKED']);
    const audit = await appPool(app).query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM audit_events WHERE target_id = $1',
      [row.rows[0]?.auth_challenge_id],
    );
    // Exactly these keys: the destination is never recorded.
    expect(audit.rows.map((r) => r.payload)).toEqual([
      { method: 'EMAIL_OTP', outcome: 'SIGN_UP_CAP_REACHED' },
    ]);

    // Over the cap, the same route still answers 202, and a registered fixture user gets a code.
    expect((await issue(newAddress(), { demo_acknowledged: true })).statusCode).toBe(202);
    const before = deliveries().delivered().length;
    expect((await issueCapped(FIXTURE_EMAIL)).issued).toBe(true);
    expect(deliveries().delivered().length).toBe(before + 1);
  });
});

// R16.2 (contributor's call, D-065): at this head the router decodes `%63` to `c`, so an encoded
// path misses the edge route throttle. The 404 guard lands in #366; the daily budget still binds.
describe('known gap before the encoded-path guard', () => {
  const encodedIssue = (destination: string) =>
    app.server.inject({
      method: 'POST',
      url: `${API_PREFIX}/auth/%63hallenges`,
      payload: { destination, method: 'EMAIL_OTP', demo_acknowledged: true },
    });

  it('routes /auth/%63hallenges to the handler, still bounded by the daily cap', async () => {
    const first = newAddress();
    expect((await encodedIssue(first)).statusCode).toBe(202);
    expect(deliveries().lastFor(first)).toBeDefined();

    // Spend the rest of the day's budget, then the encoded path sends a new address nothing.
    await appPool(app).query(
      `UPDATE auth_rate_limits SET count = $1 WHERE bucket = 'auth.signup.daily'`,
      [SIGN_UP_DAILY_CAP.value],
    );
    const over = newAddress();
    expect((await encodedIssue(over)).statusCode).toBe(202);
    expect(deliveries().lastFor(over)).toBeUndefined();
  });
});
