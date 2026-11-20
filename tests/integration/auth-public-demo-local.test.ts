/**
 * R16.1–R16.3 (contributor's call, D-065): outside STAGING the demo flag changes only the
 * acknowledgement. Self sign-up stays as D-052 has it for TEST, and no daily budget is counted.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { RecordingChallengeDelivery } from '../../src/auth/delivery.js';
import { API_PREFIX } from '../../src/release/pins.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { appPool } from '../helpers/actors.js';
import { validEnv } from '../helpers/env.js';

const SIGN_UP_TENANT = randomUUID();

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_ENV: 'TEST',
      SUAS_MIGRATIONS_MODE: 'apply',
      SUAS_PUBLIC_DEMO: 'enabled',
      SUAS_BROWSER_TENANT_ID: SIGN_UP_TENANT,
    }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

function deliveries(): RecordingChallengeDelivery {
  const delivery = app.challengeDelivery;
  if (!(delivery instanceof RecordingChallengeDelivery)) throw new Error('Not recording.');
  return delivery;
}

const newAddress = () => syntheticEmail(`demo-test-${randomUUID().slice(0, 8)}`).toLowerCase();

function issue(destination: string, extra: Record<string, unknown> = {}) {
  return app.server.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/challenges`,
    payload: { destination, method: 'EMAIL_OTP', ...extra },
  });
}

const dailyCount = async () =>
  (
    await appPool(app).query<{ total: string | null }>(
      `SELECT sum(count)::text AS total FROM auth_rate_limits WHERE bucket = 'auth.signup.daily'`,
    )
  ).rows[0]?.total ?? null;

describe('TEST with SUAS_PUBLIC_DEMO=enabled', () => {
  it('still requires the demo acknowledgement', async () => {
    const response = await issue(newAddress());
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('signs up a new address as D-052 allows in TEST, without counting the daily budget', async () => {
    const countBefore = await dailyCount();
    const email = newAddress();
    const response = await issue(email, { demo_acknowledged: true });
    expect(response.statusCode).toBe(202);
    expect(deliveries().lastFor(email)).toBeDefined();
    expect(await dailyCount()).toBe(countBefore);
  });
});
