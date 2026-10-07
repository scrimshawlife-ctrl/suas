import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  ChallengeVerificationFailedError,
  issueChallenge,
  RecordingChallengeDelivery,
  verifyChallenge,
} from '../../src/auth/index.js';
import {
  DEMO_FIXED_CODE,
  DEMO_FIXED_CODE_DESTINATION,
  demoFixedCodeFor,
} from '../../src/auth/demo-fixed-code.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { TEST_SESSION_SECRET } from '../helpers/env.js';

const pool: Pool = createTestPool();

const fixedOtpCodeFor = demoFixedCodeFor({
  environment: 'LOCAL',
  demoFixedCode: true,
  databaseUrl: 'postgresql://suas:suas@localhost:5432/suas_demo',
});

beforeEach(() => resetKernelTables(pool));

afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

describe('demo fixed code', () => {
  it('delivers the fixed code to the demo user and verifies it', async () => {
    const tenantId = syntheticTenantId();
    const demo = await createUser(pool, {
      tenantId,
      email: DEMO_FIXED_CODE_DESTINATION,
      status: 'ACTIVE',
    });
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    const deps = { pool, sessionSecret: TEST_SESSION_SECRET, delivery, fixedOtpCodeFor };
    await issueChallenge(deps, {
      tenantId,
      destination: DEMO_FIXED_CODE_DESTINATION,
      method: 'EMAIL_OTP',
    });
    expect(delivery.lastFor(DEMO_FIXED_CODE_DESTINATION)?.secret).toBe(DEMO_FIXED_CODE);
    const user = await verifyChallenge(deps, {
      tenantId,
      destination: DEMO_FIXED_CODE_DESTINATION,
      secret: DEMO_FIXED_CODE,
    });
    expect(user.userId).toBe(demo.userId);
  });

  it('delivers a six digit code for a normal user', async () => {
    const tenantId = syntheticTenantId();
    const destination = syntheticEmail('newvet');
    const newvet = await createUser(pool, { tenantId, email: destination, status: 'ACTIVE' });
    const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
    const deps = { pool, sessionSecret: TEST_SESSION_SECRET, delivery, fixedOtpCodeFor };
    await issueChallenge(deps, { tenantId, destination, method: 'EMAIL_OTP' });
    const secret = delivery.lastFor(destination)?.secret;
    if (secret === undefined) {
      throw new Error('expected a delivered secret');
    }
    expect(secret).toMatch(/^\d{6}$/);
    const user = await verifyChallenge(deps, { tenantId, destination, secret });
    expect(user.userId).toBe(newvet.userId);
  });

  it('only accepts the fixed code when the provider delivers it', async () => {
    const tenantId = syntheticTenantId();
    await createUser(pool, { tenantId, email: DEMO_FIXED_CODE_DESTINATION, status: 'ACTIVE' });
    const stagingProvider = demoFixedCodeFor({
      environment: 'STAGING',
      demoFixedCode: true,
      databaseUrl: undefined,
    });
    expect(stagingProvider).toBeUndefined();

    for (const fixedOtpCodeForCase of [undefined, stagingProvider]) {
      const delivery = new RecordingChallengeDelivery('fake', ['EMAIL']);
      const deps = {
        pool,
        sessionSecret: TEST_SESSION_SECRET,
        delivery,
        fixedOtpCodeFor: fixedOtpCodeForCase,
      };
      await issueChallenge(deps, {
        tenantId,
        destination: DEMO_FIXED_CODE_DESTINATION,
        method: 'EMAIL_OTP',
      });
      const secret = delivery.lastFor(DEMO_FIXED_CODE_DESTINATION)?.secret;
      if (secret === undefined) {
        throw new Error('expected a delivered secret');
      }
      expect(secret).toMatch(/^\d{6}$/);
      if (secret === DEMO_FIXED_CODE) {
        const user = await verifyChallenge(deps, {
          tenantId,
          destination: DEMO_FIXED_CODE_DESTINATION,
          secret: DEMO_FIXED_CODE,
        });
        expect(user.userId).toBeTruthy();
      } else {
        await expect(
          verifyChallenge(deps, {
            tenantId,
            destination: DEMO_FIXED_CODE_DESTINATION,
            secret: DEMO_FIXED_CODE,
          }),
        ).rejects.toBeInstanceOf(ChallengeVerificationFailedError);
      }
    }
  });
});
