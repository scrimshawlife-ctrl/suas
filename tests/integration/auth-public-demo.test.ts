/**
 * R16.1–R16.3 (contributor proposal, not released; owner review on #363): STAGING public demo
 * sign-up. Anyone may sign up after the acknowledgement, daily caps bound sends without changing
 * the answer (D-056), registered fixture users keep working, and only they reach VA confirmation.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { issueChallenge } from '../../src/auth/challenge.js';
import { RecordingChallengeDelivery } from '../../src/auth/delivery.js';
import { stagingAccessFromConfig } from '../../src/auth/staging-access.js';
import type { PublicDemoLimits } from '../../src/config/index.js';
import { createServer } from '../../src/http/server.js';
import { FixtureVeteranConfirmation, VA_NOTICE_V1 } from '../../src/identity/index.js';
import { createSession } from '../../src/auth/index.js';
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

// The demo counters are shared rows in the TEST database; each test starts from zero.
beforeEach(async () => {
  await appPool(app).query(
    `DELETE FROM auth_rate_limits
      WHERE bucket IN ('auth.signup.daily', 'auth.challenge.address.daily', 'auth.challenge.route')`,
  );
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

/** issueChallenge as the route calls it, with the configured limits and `limits` over them. */
function issueWith(
  destination: string,
  limits: Partial<PublicDemoLimits> = {},
  method: 'EMAIL_OTP' | 'MAGIC_LINK' = 'EMAIL_OTP',
) {
  const access = stagingAccessFromConfig(app.config);
  return issueChallenge(
    {
      pool: appPool(app),
      sessionSecret: TEST_SESSION_SECRET,
      delivery: deliveries(),
      stagingAccess: { ...access, publicDemoLimits: { ...app.config.publicDemoLimits, ...limits } },
    },
    { tenantId: SIGN_UP_TENANT, destination, method, allowSignUp: true },
  );
}
const issueCapped = (destination: string) => issueWith(destination, { dailySignUpCap: 1 });

const auditOutcomes = async (destination: string) =>
  (
    await appPool(app).query<{ payload: Record<string, unknown> }>(
      `SELECT a.payload FROM audit_events a
         JOIN auth_challenges c ON a.target_id = c.auth_challenge_id::text
        WHERE c.destination = $1
        ORDER BY a.occurred_at`,
      [destination],
    )
  ).rows.map((row) => row.payload.outcome);

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

  // Owner review on #363: only an address with no account counts against the shared cap.
  it('counts only new addresses against the daily cap; an existing user still gets a code', async () => {
    expect((await issueCapped(FIXTURE_EMAIL)).issued).toBe(true);
    expect((await issueCapped(newAddress())).issued).toBe(true);
    expect((await issueCapped(newAddress())).issued).toBe(false);
    const before = deliveries().delivered().length;
    expect((await issueCapped(FIXTURE_EMAIL)).issued).toBe(true);
    expect(deliveries().delivered().length).toBe(before + 1);
  });

  // A later 15-minute window for `address`, so only the daily caps apply.
  const clearIssueWindow = (address: string) =>
    appPool(app).query(
      `DELETE FROM auth_rate_limits WHERE bucket = 'auth.challenge.issue' AND subject = $1`,
      [address],
    );

  it('sends no 6th code to a new address in a day and answers the same 202', async () => {
    const email = newAddress();
    for (let sent = 0; sent < 5; sent += 1) {
      await clearIssueWindow(email);
      expect((await issueWith(email)).issued).toBe(true);
    }
    await clearIssueWindow(email);
    const before = deliveries().delivered().length;
    const sixth = await issue(email, { demo_acknowledged: true });
    expect(sixth.statusCode).toBe(202);
    expect(deliveries().delivered().length).toBe(before);
    expect((await auditOutcomes(email)).at(-1)).toBe('ADDRESS_DAILY_CAP_REACHED');
  });

  // Security review: anonymous requests must not lock an existing account out for a day.
  it('keeps sending codes to an existing user past 5 requests a day', async () => {
    for (let sent = 0; sent < 7; sent += 1) {
      await clearIssueWindow(FIXTURE_EMAIL);
      expect((await issueWith(FIXTURE_EMAIL)).issued).toBe(true);
    }
    await clearIssueWindow(FIXTURE_EMAIL);
  });

  it('counts MAGIC_LINK and +tag variants of one address against one per-address budget', async () => {
    const local = `demo-plus-${randomUUID().slice(0, 8)}`;
    const tagged = (tag: string) => `${local}+${tag}@example.invalid`;
    // MAGIC_LINK to an address with no account sends nothing, but it spends the budget.
    expect((await issueWith(tagged('1'), { addressDailyCap: 2 }, 'MAGIC_LINK')).issued).toBe(false);
    expect((await issueWith(tagged('2'), { addressDailyCap: 2 })).issued).toBe(true);
    expect((await issueWith(`${local}@example.invalid`, { addressDailyCap: 2 })).issued).toBe(
      false,
    );
    expect((await auditOutcomes(`${local}@example.invalid`)).at(-1)).toBe(
      'ADDRESS_DAILY_CAP_REACHED',
    );
    expect(deliveries().lastFor(tagged('2'))).toBeDefined();
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

describe('STAGING public demo auth route guards', () => {
  it('answers 404 to a percent-encoded auth path and sends nothing', async () => {
    const email = newAddress();
    const before = deliveries().delivered().length;
    for (const url of [
      `${API_PREFIX}/auth/%63hallenges`,
      `${API_PREFIX}/%61uth/challenges`,
      '/app/auth/%63hallenges',
    ]) {
      const response = await app.server.inject({
        method: 'POST',
        url,
        payload: { destination: email, method: 'EMAIL_OTP', demo_acknowledged: true },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('NOT_FOUND');
    }
    expect(deliveries().delivered().length).toBe(before);
    const rows = await appPool(app).query('SELECT 1 FROM auth_challenges WHERE destination = $1', [
      email,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('answers 429 RATE_LIMITED once the per-minute challenge route limit is spent', async () => {
    const server = createServer({
      config: {
        ...app.config,
        publicDemoLimits: { ...app.config.publicDemoLimits, routeLimitPerMinute: 1 },
      },
      buildInfo: () => app.buildInfo,
      pool: appPool(app),
      challengeDelivery: app.challengeDelivery,
      mfa: app.mfa,
      logger: false,
    });
    const post = () =>
      server.inject({
        method: 'POST',
        url: `${API_PREFIX}/auth/challenges`,
        payload: { destination: newAddress(), method: 'EMAIL_OTP', demo_acknowledged: true },
      });
    expect((await post()).statusCode).toBe(202);
    const over = await post();
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    expect(over.headers['retry-after']).toBeDefined();
    await server.close();
  });
});

// Owner review on #363: the VA sandbox stays fixture-only in demo mode; self-attestation does not.
describe('STAGING public demo VA confirmation', () => {
  const confirm = async (userId: string) => {
    const session = await createSession(appPool(app), TEST_SESSION_SECRET, {
      tenantId: SIGN_UP_TENANT,
      userId,
    });
    const server = createServer({
      config: app.config,
      buildInfo: () => app.buildInfo,
      pool: appPool(app),
      challengeDelivery: app.challengeDelivery,
      mfa: app.mfa,
      veteranConfirmation: new FixtureVeteranConfirmation(),
      logger: false,
    });
    // A name that does not match the account: past the gate this is 409, with no VA call.
    const response = await server.inject({
      method: 'POST',
      url: `${API_PREFIX}/veterans/me/verification/va/confirm`,
      headers: { authorization: `Bearer ${session.credential}`, 'idempotency-key': randomUUID() },
      payload: {
        noticeVersion: VA_NOTICE_V1,
        firstName: 'Nomatch',
        lastName: 'Person',
        birthDate: '1960-02-29',
        streetAddressLine1: '1 Example Way',
        city: 'Exampleton',
        state: 'CA',
        zipCode: '00000',
      },
    });
    await server.close();
    return response;
  };

  it('refuses a demo account with 503 and lets a registered fixture user through', async () => {
    const demoUser = await createUser(appPool(app), {
      tenantId: SIGN_UP_TENANT,
      email: newAddress(),
      status: 'ACTIVE',
    });
    const refused = await confirm(demoUser.userId);
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe('ID_VERIFICATION_UNAVAILABLE');
    const fixture = await confirm(FIXTURE_USER);
    expect(fixture.statusCode).toBe(409);
    expect(fixture.json().error.code).toBe('VA_NAME_MISMATCH');
  });
});
