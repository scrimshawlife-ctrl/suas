/**
 * Check-In completion → sv-001 settle → RED case (requires PostgreSQL).
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { findNonClosedCase } from '../../src/coordination/index.js';
import { DispatchingJobQueue, InMemoryJobQueue } from '../../src/jobs/index.js';
import {
  completeCheckIn,
  ensurePublishedQv001,
  listQuestions,
  parseComputeJobPayload,
  QV_001_VERSION,
  runSupportSignalComputeJob,
  saveResponse,
  startCheckIn,
} from '../../src/signals/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { validEnv } from '../helpers/env.js';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';

const pool: Pool = createTestPool();
const config = loadConfig(validEnv());

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

const A0: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};

async function answerCheckIn(
  tenantId: string,
  checkInId: string,
  answers: Readonly<Record<string, string>>,
): Promise<void> {
  const questions = await listQuestions(pool, QV_001_VERSION);
  const options = await pool.query<{
    question_id: string;
    question_key: string;
    option_key: string;
    answer_option_id: string;
  }>(
    `SELECT q.question_id, q.question_key, o.option_key, o.answer_option_id
     FROM questions q
     JOIN answer_options o ON o.question_id = q.question_id
     WHERE q.questionnaire_version = $1`,
    [QV_001_VERSION],
  );
  for (const question of questions) {
    const optionKey = answers[question.questionKey];
    if (optionKey === undefined) continue;
    const option = options.rows.find(
      (row) => row.question_id === question.questionId && row.option_key === optionKey,
    );
    if (option === undefined) throw new Error(`no option ${optionKey} for ${question.questionKey}`);
    await saveResponse(pool, {
      tenantId,
      checkInId,
      questionId: question.questionId,
      answerOptionId: option.answer_option_id,
    });
  }
}

async function veteranOnQv001() {
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
  await ensurePublishedQv001(pool, admin.userId);
  const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
  return { tenantId, veteran, checkIn };
}

describe('runSupportSignalComputeJob', () => {
  it('skips a Check-In that is not qv-001', async () => {
    const tenantId = syntheticTenantId();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    // No qv-001 published: startCheckIn fails. Create a non-qv check-in via the
    // test questionnaire path used by Slice 9.
    const { createQuestionnaireVersion, publishQuestionnaireVersion } =
      await import('../../src/signals/index.js');
    await createQuestionnaireVersion(pool, {
      questionnaireVersion: `qv-test-${randomUUID().slice(0, 8)}`,
      tenantId,
      title: 'Synthetic',
      questions: [
        {
          questionKey: 'sleep_quality',
          prompt: 'Synthetic',
          dimension: 'sleep',
          required: true,
          options: [{ optionKey: 'good', label: 'Good' }],
        },
      ],
    });
    const version = await pool.query<{ questionnaire_version: string }>(
      `SELECT questionnaire_version FROM questionnaire_versions WHERE tenant_id = $1`,
      [tenantId],
    );
    const qv = version.rows[0]?.questionnaire_version;
    if (qv === undefined) throw new Error('missing version');
    await publishQuestionnaireVersion(pool, {
      questionnaireVersion: qv,
      tenantId,
      publishedBy: veteran.userId,
    });
    const checkIn = await startCheckIn(pool, { tenantId, veteranUserId: veteran.userId });
    const questions = await listQuestions(pool, checkIn.questionnaireVersion);
    const required = questions[0];
    if (required === undefined) throw new Error('no question');
    const option = await pool.query<{ answer_option_id: string }>(
      `SELECT answer_option_id FROM answer_options WHERE question_id = $1`,
      [required.questionId],
    );
    const answerOptionId = option.rows[0]?.answer_option_id;
    if (answerOptionId === undefined) throw new Error('no option');
    await saveResponse(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      questionId: required.questionId,
      answerOptionId,
    });
    await completeCheckIn(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      actorId: veteran.userId,
    });
    const result = await runSupportSignalComputeJob(pool, config, {
      tenantId,
      checkInId: checkIn.checkInId,
    });
    expect(result).toEqual({ status: 'SKIPPED', reason: 'NOT_QV_001' });
    expect(await findNonClosedCase(pool, tenantId, veteran.userId)).toBeUndefined();
  });

  it('settles GREEN from A0 and does not open a case', async () => {
    const { tenantId, veteran, checkIn } = await veteranOnQv001();
    await answerCheckIn(tenantId, checkIn.checkInId, A0);
    await completeCheckIn(pool, {
      tenantId,
      checkInId: checkIn.checkInId,
      actorId: veteran.userId,
    });
    const result = await runSupportSignalComputeJob(pool, config, {
      tenantId,
      checkInId: checkIn.checkInId,
    });
    expect(result.status).toBe('SETTLED');
    expect(result.signal?.level).toBe('GREEN');
    expect(await findNonClosedCase(pool, tenantId, veteran.userId)).toBeUndefined();
  });

  it('opens a RED case when GV-007 answers settle through the job dispatcher', async () => {
    const { tenantId, veteran, checkIn } = await veteranOnQv001();
    await answerCheckIn(tenantId, checkIn.checkInId, {
      ...A0,
      safe_now: 'NO_IMMEDIATE_HELP',
    });
    const inner = new InMemoryJobQueue();
    const queue = new DispatchingJobQueue(inner, {
      'support-signal.compute': async (request) => {
        const parsed = parseComputeJobPayload(request.payload, request.tenantId);
        if (parsed === undefined) return;
        await runSupportSignalComputeJob(pool, config, parsed);
      },
    });
    await completeCheckIn(
      pool,
      { tenantId, checkInId: checkIn.checkInId, actorId: veteran.userId },
      { jobQueue: queue },
    );
    expect(inner.enqueued()[0]?.jobType).toBe('support-signal.compute');
    const opened = await findNonClosedCase(pool, tenantId, veteran.userId);
    expect(opened?.prioritySignalLevel).toBe('RED');
    expect(opened?.status).toBe('OPEN');
  });
});
