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
import type { JsonObject } from '../jobs/index.js';
import { findNonClosedCase } from '../coordination/cases.js';
import { canonicalInputFor, findCheckIn } from './check-ins.js';
import { computeSignal } from './engine.js';
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
    const computation = computeSignal(SV_001_VERSION, {
      checkInId: canonical.checkInId,
      sourceReference: canonical.sourceReference,
      questionnaireVersion: canonical.questionnaireVersion,
      answers: canonical.answers,
      incomplete: canonical.incomplete,
    });
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
    return { status: 'SETTLED', signal: settled.signal };
  } catch (error) {
    if (error instanceof MissingRequiredSafetyInputError) {
      return { status: 'REFUSED', reason: 'MISSING_SAFETY_INPUT' };
    }
    throw error;
  }
}

/** Convenience for tests: settled RED should have opened a non-closed case. */
export async function caseOpenedForVeteran(pool: Pool, tenantId: string, veteranUserId: string) {
  return findNonClosedCase(pool, tenantId, veteranUserId);
}
