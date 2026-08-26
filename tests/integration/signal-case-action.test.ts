/**
 * APPLY_EFFECTIVE_SIGNAL — G-I-28 transcribed from SAFETY.md §3.2.
 *
 * Requires PostgreSQL. TEST stays on fixture scoring; this suite asserts the
 * case write that follows a *settled* level, independent of which engine
 * produced it. No provider adapters.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { findNonClosedCase, openCase } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/transaction.js';
import { listAggregateEvents } from '../../src/events/index.js';
import { createUser } from '../../src/identity/index.js';
import {
  createQuestionnaireVersion,
  overrideSignal,
  publishQuestionnaireVersion,
  settlePrimarySignal,
  startCheckIn,
} from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

async function fixture() {
  const tenantId = syntheticTenantId();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const admin = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`admin-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const responder = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`resp-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const version = `qv-test-${randomUUID().slice(0, 8)}`;
  await createQuestionnaireVersion(pool, {
    questionnaireVersion: version,
    tenantId,
    title: 'Synthetic test questionnaire',
    questions: [
      {
        questionKey: 'sleep_quality',
        prompt: 'Synthetic prompt',
        dimension: 'sleep',
        required: true,
        options: [
          { optionKey: 'good', label: 'Good' },
          { optionKey: 'poor', label: 'Poor' },
        ],
      },
    ],
  });
  await publishQuestionnaireVersion(pool, {
    questionnaireVersion: version,
    tenantId,
    publishedBy: admin.userId,
  });
  const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
  return { tenantId, veteran, responder, version, checkIn };
}

function settleInput(
  context: Awaited<ReturnType<typeof fixture>>,
  level: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED',
) {
  return {
    tenantId: context.tenantId,
    veteranUserId: context.veteran.userId,
    sourceType: 'CHECK_IN' as const,
    checkInId: context.checkIn.checkInId,
    level,
    signalVersion: 'sv-unreleased-fixture-1',
    inputQuestionnaireVersion: context.version,
    basis: { fixture: true },
  };
}

describe('SAFETY.md §3.2 — APPLY_EFFECTIVE_SIGNAL', () => {
  it('opens one RED case and emits one CASE_CREATED', async () => {
    const context = await fixture();
    await settlePrimarySignal(pool, settleInput(context, 'RED'));

    const opened = await findNonClosedCase(pool, context.tenantId, context.veteran.userId);
    expect(opened?.prioritySignalLevel).toBe('RED');
    expect(opened?.status).toBe('OPEN');

    const events = await listAggregateEvents(pool, {
      tenantId: context.tenantId,
      aggregateType: 'SupportCase',
      aggregateId: opened?.caseId ?? '',
    });
    expect(events.filter((event) => event.eventType === 'CASE_CREATED')).toHaveLength(1);
  });

  it('does not open a case from YELLOW', async () => {
    const context = await fixture();
    await settlePrimarySignal(pool, settleInput(context, 'YELLOW'));
    expect(await findNonClosedCase(pool, context.tenantId, context.veteran.userId)).toBeUndefined();
  });

  it('replays of the same RED settlement do not create a second case', async () => {
    const context = await fixture();
    const first = await settlePrimarySignal(pool, settleInput(context, 'RED'));
    const replay = await settlePrimarySignal(pool, settleInput(context, 'RED'));
    expect(replay.deduplicated).toBe(true);
    expect(replay.signal.supportSignalId).toBe(first.signal.supportSignalId);

    const opened = await findNonClosedCase(pool, context.tenantId, context.veteran.userId);
    const events = await listAggregateEvents(pool, {
      tenantId: context.tenantId,
      aggregateType: 'SupportCase',
      aggregateId: opened?.caseId ?? '',
    });
    expect(events.filter((event) => event.eventType === 'CASE_CREATED')).toHaveLength(1);
  });

  it('raises priority on an existing non-closed case instead of opening a second', async () => {
    const context = await fixture();
    await withTransaction(pool, (tx) =>
      openCase(tx, {
        tenantId: context.tenantId,
        veteranUserId: context.veteran.userId,
        prioritySignalLevel: 'YELLOW',
        actorType: 'VETERAN',
        actorId: context.veteran.userId,
      }),
    );
    await settlePrimarySignal(pool, settleInput(context, 'RED'));

    const current = await findNonClosedCase(pool, context.tenantId, context.veteran.userId);
    expect(current?.prioritySignalLevel).toBe('RED');
    const listed = await pool.query(
      `SELECT count(*)::int AS n FROM support_cases WHERE tenant_id = $1 AND veteran_user_id = $2`,
      [context.tenantId, context.veteran.userId],
    );
    expect(listed.rows[0]?.n).toBe(1);
  });

  it('does not downgrade an existing RED case when a later GREEN settles', async () => {
    const context = await fixture();
    await settlePrimarySignal(pool, settleInput(context, 'RED'));
    const later = await startCheckIn(pool, {
      tenantId: context.tenantId,
      veteranUserId: context.veteran.userId,
    });
    await settlePrimarySignal(pool, {
      ...settleInput(context, 'GREEN'),
      checkInId: later.checkInId,
      signalVersion: 'sv-unreleased-fixture-2',
    });
    const current = await findNonClosedCase(pool, context.tenantId, context.veteran.userId);
    expect(current?.prioritySignalLevel).toBe('RED');
  });

  it('opens a new case when the only prior case is CLOSED, and does not REOPEN it', async () => {
    const context = await fixture();
    const closedId = randomUUID();
    await pool.query(
      `INSERT INTO support_cases (case_id, tenant_id, veteran_user_id, status, priority_signal_level)
       VALUES ($1, $2, $3, 'CLOSED', 'YELLOW')`,
      [closedId, context.tenantId, context.veteran.userId],
    );
    await settlePrimarySignal(pool, settleInput(context, 'RED'));

    const current = await findNonClosedCase(pool, context.tenantId, context.veteran.userId);
    expect(current?.caseId).not.toBe(closedId);
    expect(current?.status).toBe('OPEN');
    expect(current?.prioritySignalLevel).toBe('RED');
    const closed = await pool.query(`SELECT status FROM support_cases WHERE case_id = $1`, [
      closedId,
    ]);
    expect(closed.rows[0]?.status).toBe('CLOSED');
  });

  it('opens a case when a responder override settles RED', async () => {
    const context = await fixture();
    const primary = await settlePrimarySignal(pool, settleInput(context, 'YELLOW'));
    expect(await findNonClosedCase(pool, context.tenantId, context.veteran.userId)).toBeUndefined();

    await overrideSignal(pool, {
      tenantId: context.tenantId,
      overrideOfSignalId: primary.signal.supportSignalId,
      level: 'RED',
      actorId: context.responder.userId,
      reason: 'responder review of the settled signal',
    });
    const opened = await findNonClosedCase(pool, context.tenantId, context.veteran.userId);
    expect(opened?.prioritySignalLevel).toBe('RED');
  });
});
