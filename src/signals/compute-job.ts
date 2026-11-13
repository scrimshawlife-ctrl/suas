/**
 * `support-signal.compute` job — CHECKINS.md §6.3.
 *
 * Completing a Check-In requests durable computation. It does not itself settle
 * a Support Signal (EVENT_MODEL.md §3.1). This handler is that requested work.
 *
 * Only the released pair `qv-001` + `sv-001` is computed. Other questionnaire
 * versions stay unsettled rather than inventing a fixture score. APPLY_EFFECTIVE_SIGNAL
 * then opens a case when the settled level is RED.
 */

import type { Pool } from 'pg';
import type { SuasConfig } from '../config/index.js';
import type { Queryable } from '../db/index.js';
import type { DurableJobQueuePort, JsonObject } from '../jobs/index.js';
import { findCurrentCase } from '../coordination/cases.js';
import { canonicalInputFor, findCheckIn, supportSignalComputeRequest } from './check-ins.js';
import { computeSignal } from './engine.js';
import { alertTrustedContactsOfRed } from './red-alert.js';
import { MissingRequiredSafetyInputError, QV_001_VERSION, SV_001_VERSION } from './sv-001.js';
import { settlePrimarySignal, type SupportSignal } from './settlement.js';

export type SupportSignalComputeStatus = 'SETTLED' | 'SKIPPED' | 'REFUSED';

export type SupportSignalComputeReason =
  'NOT_QV_001' | 'MODE_DISABLED' | 'NOT_COMPLETED' | 'MISSING_CHECK_IN' | 'MISSING_SAFETY_INPUT';

export interface SupportSignalComputeResult {
  readonly status: SupportSignalComputeStatus;
  readonly reason?: SupportSignalComputeReason;
  readonly signal?: SupportSignal;
}

export function parseComputeJobPayload(
  payload: JsonObject,
  tenantId: string | undefined,
): { tenantId: string; checkInId: string } | undefined {
  const checkInId = payload.check_in_id;
  if (typeof checkInId !== 'string' || tenantId === undefined) return undefined;
  return { tenantId, checkInId };
}

export async function runSupportSignalComputeJob(
  pool: Pool,
  config: SuasConfig,
  input: { tenantId: string; checkInId: string },
  deps: { jobQueue?: DurableJobQueuePort | undefined } = {},
): Promise<SupportSignalComputeResult> {
  if (config.supportSignalMode === 'disabled') {
    return { status: 'SKIPPED', reason: 'MODE_DISABLED' };
  }

  const checkIn = await findCheckIn(pool, input.tenantId, input.checkInId);
  if (checkIn === undefined) {
    return { status: 'SKIPPED', reason: 'MISSING_CHECK_IN' };
  }
  if (checkIn.status !== 'COMPLETED') {
    return { status: 'SKIPPED', reason: 'NOT_COMPLETED' };
  }
  if (checkIn.questionnaireVersion !== QV_001_VERSION) {
    return { status: 'SKIPPED', reason: 'NOT_QV_001' };
  }

  const canonical = await canonicalInputFor(pool, input.tenantId, input.checkInId);
  try {
    const computation = computeSignal(
      SV_001_VERSION,
      {
        checkInId: canonical.checkInId,
        sourceReference: canonical.sourceReference,
        questionnaireVersion: canonical.questionnaireVersion,
        answers: canonical.answers,
        incomplete: canonical.incomplete,
      },
      { supportSignalMode: config.supportSignalMode },
    );
    const settled = await settlePrimarySignal(pool, {
      tenantId: input.tenantId,
      veteranUserId: checkIn.veteranUserId,
      sourceType: 'CHECK_IN',
      checkInId: input.checkInId,
      level: computation.level,
      signalVersion: SV_001_VERSION,
      inputQuestionnaireVersion: QV_001_VERSION,
      basis: computation.basis,
    });
    // Also on a replayed settlement: if the first run died after settling, the
    // retry must still alert. Per-contact dedupe keys keep it to one alert each.
    if (settled.signal.level === 'RED') {
      await alertTrustedContactsOfRed(pool, settled.signal, { jobQueue: deps.jobQueue });
    }
    return { status: 'SETTLED', signal: settled.signal };
  } catch (error) {
    if (error instanceof MissingRequiredSafetyInputError) {
      return { status: 'REFUSED', reason: 'MISSING_SAFETY_INPUT' };
    }
    throw error;
  }
}

/** Completion enqueues inline; this grace keeps the sweep from racing that first run. */
const REQUEUE_GRACE_MS = 2 * 60 * 1000;

/**
 * CHECKINS.md §6 rules 6-7: find COMPLETED Check-Ins with no settled primary signal and no
 * compute job (the enqueue was lost after the commit) and enqueue the job under its one
 * identity. Ones that already have a job, even a dead-lettered one, are left to operations.
 */
export async function requeueUnsettledCheckIns(
  db: Queryable,
  jobQueue: DurableJobQueuePort,
  options: { now?: Date; limit?: number } = {},
): Promise<{ requeued: number }> {
  const cutoff = new Date((options.now ?? new Date()).getTime() - REQUEUE_GRACE_MS);
  const lost = await db.query<{ tenant_id: string; check_in_id: string }>(
    `SELECT c.tenant_id, c.check_in_id
       FROM check_ins c
      WHERE c.status = 'COMPLETED' AND c.completed_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM support_signals s
           WHERE s.check_in_id = c.check_in_id AND s.computation_kind = 'PRIMARY')
        AND NOT EXISTS (
          SELECT 1 FROM job_outbox j
           WHERE j.tenant_id = c.tenant_id::text AND j.job_type = 'support-signal.compute'
             AND j.idempotency_key = 'support-signal:' || c.check_in_id::text)
      ORDER BY c.completed_at
      LIMIT $2`,
    [cutoff.toISOString(), options.limit ?? 100],
  );
  for (const row of lost.rows) {
    await jobQueue.enqueue(supportSignalComputeRequest(row.tenant_id, row.check_in_id));
  }
  return { requeued: lost.rows.length };
}

/** Convenience for tests: settled RED should have opened a non-closed case. */
export async function caseOpenedForVeteran(pool: Pool, tenantId: string, veteranUserId: string) {
  return findCurrentCase(pool, tenantId, veteranUserId);
}
