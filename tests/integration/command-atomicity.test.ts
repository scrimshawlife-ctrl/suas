/**
 * Case and contact commands commit with the caller's transaction, and event dedupe keys
 * never resolve to another aggregate's fact (requires PostgreSQL).
 *
 * SUAS-specs API.md §7 rules 2, 3 and 5; EVENT_MODEL.md §2.1.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/index.js';
import { appendDomainEvent, EventIdentityConflictError } from '../../src/events/index.js';
import {
  executeCaseCommandInTx,
  findCase,
  listContactAttempts,
  openCase,
  recordContact,
  recordContactInTx,
} from '../../src/coordination/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { holdCase } from '../helpers/hold-case.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function user(tenantId: string, label: string) {
  return createUser(pool, {
    tenantId,
    email: syntheticEmail(`${label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
}

/** A Veteran's case held by `helperId`. */
async function heldCase(tenantId: string, helperId: string) {
  const veteran = await user(tenantId, 'veteran');
  const opened = await withTransaction(pool, (tx) =>
    openCase(tx, {
      tenantId,
      veteranUserId: veteran.userId,
      actorType: 'VETERAN',
      actorId: veteran.userId,
    }),
  );
  return holdCase(pool, {
    tenantId,
    caseId: opened.supportCase.caseId,
    acceptedByUserId: helperId,
  });
}

class Rollback extends Error {}

describe('API.md §7 rule 3: a command commits only with its transaction', () => {
  it('rolls a case command and a contact back with the caller transaction', async () => {
    const tenantId = syntheticTenantId();
    const helper = await user(tenantId, 'helper');
    const held = await heldCase(tenantId, helper.userId);

    await expect(
      withTransaction(pool, async (tx) => {
        await executeCaseCommandInTx(tx, {
          tenantId,
          caseId: held.caseId,
          command: 'ACTIVATE',
          actorId: helper.userId,
          actorType: 'USER',
        });
        await recordContactInTx(tx, {
          tenantId,
          caseId: held.caseId,
          loggedByUserId: helper.userId,
          command: 'log-contact-attempt',
          channel: 'PHONE',
          outcome: 'PENDING',
        });
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);

    expect((await findCase(pool, tenantId, held.caseId))?.status).toBe(held.status);
    expect(await listContactAttempts(pool, tenantId, held.caseId)).toEqual([]);
  });
});

describe('EVENT_MODEL.md §2.1: an event key belongs to one aggregate', () => {
  it("records the same caller key on a second case instead of returning the first case's contact", async () => {
    const tenantId = syntheticTenantId();
    const helper = await user(tenantId, 'helper');
    const first = await heldCase(tenantId, helper.userId);
    const second = await heldCase(tenantId, helper.userId);
    const base = {
      tenantId,
      loggedByUserId: helper.userId,
      command: 'log-contact-attempt',
      channel: 'PHONE',
      outcome: 'PENDING',
      idempotencyKey: 'reused-key',
    } as const;

    await recordContact(pool, { ...base, caseId: first.caseId });
    const other = await recordContact(pool, { ...base, caseId: second.caseId });
    expect(other.deduplicated).toBe(false);
    expect(other.contactAttempt.caseId).toBe(second.caseId);

    const replay = await recordContact(pool, { ...base, caseId: second.caseId });
    expect(replay.deduplicated).toBe(true);
    expect(replay.contactAttempt.contactAttemptId).toBe(other.contactAttempt.contactAttemptId);
  });

  it('refuses a key that already identifies a fact of another aggregate', async () => {
    const tenantId = syntheticTenantId();
    const event = (aggregateId: string) => ({
      eventType: 'CASE_CREATED' as const,
      aggregateType: 'SupportCase',
      aggregateId,
      tenantId,
      actorType: 'SYSTEM' as const,
      actorId: 'test',
      payload: {},
      idempotencyKey: 'shared-key',
    });
    await withTransaction(pool, (tx) => appendDomainEvent(tx, event(randomUUID())));
    await expect(
      withTransaction(pool, (tx) => appendDomainEvent(tx, event(randomUUID()))),
    ).rejects.toThrow(EventIdentityConflictError);
  });
});
