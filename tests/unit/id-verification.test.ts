/**
 * ID verification port and its fake (V1_PROJECT_PLAN.md §4.3 F2, §7).
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { FakeIdVerification } from '../../src/identity/fake-id-verification.js';
import { createIdVerificationPort } from '../../src/identity/id-verification.js';
import { validEnv } from '../helpers/env.js';

describe('FakeIdVerification', () => {
  it('starts a pending check and resolves scripted outcomes', async () => {
    const fake = new FakeIdVerification();
    const started = await fake.startCheck({ subjectId: 'u1', idempotencyKey: 'k1' });
    expect(started.status).toBe('PENDING');
    if (started.status !== 'PENDING') throw new Error('unreachable');

    expect(await fake.readOutcome(started.checkId)).toEqual({ status: 'PENDING' });
    fake.resolve(started.checkId, 'VERIFIED');
    expect(await fake.readOutcome(started.checkId)).toEqual({ status: 'VERIFIED' });
    fake.resolve(started.checkId, 'NOT_CONFIRMED');
    expect(await fake.readOutcome(started.checkId)).toEqual({ status: 'NOT_CONFIRMED' });
  });

  it('reuses the check for a repeated idempotency key', async () => {
    const fake = new FakeIdVerification();
    const first = await fake.startCheck({ subjectId: 'u1', idempotencyKey: 'k1' });
    const again = await fake.startCheck({ subjectId: 'u1', idempotencyKey: 'k1' });
    const other = await fake.startCheck({ subjectId: 'u1', idempotencyKey: 'k2' });
    expect(again).toEqual(first);
    expect(other).not.toEqual(first);
  });

  it('reports UNAVAILABLE for an unknown check and during an outage', async () => {
    const fake = new FakeIdVerification();
    expect(await fake.readOutcome('nope')).toEqual({ status: 'UNAVAILABLE' });
    fake.setAvailable(false);
    expect(await fake.startCheck({ subjectId: 'u1', idempotencyKey: 'k1' })).toEqual({
      status: 'UNAVAILABLE',
    });
  });
});

describe('createIdVerificationPort', () => {
  it('returns undefined when disabled', () => {
    expect(createIdVerificationPort(loadConfig(validEnv()))).toBeUndefined();
  });

  it('returns a fake that verifies immediately when mode is fake', async () => {
    const port = createIdVerificationPort(
      loadConfig(validEnv({ SUAS_ID_VERIFICATION_MODE: 'fake' })),
    );
    const started = await port?.startCheck({ subjectId: 'u1', idempotencyKey: 'k1' });
    if (started?.status !== 'PENDING') throw new Error('expected a started check');
    expect(await port?.readOutcome(started.checkId)).toEqual({ status: 'VERIFIED' });
  });
});
