/**
 * APPLY_EFFECTIVE_SIGNAL — G-I-28 transcribed from SAFETY.md §3.2.
 *
 * Spec citations:
 * - SUAS-specs SAFETY.md §3.2 (effective RED must open or update a Support Case
 *   with priority_signal_level=RED if one is not already open in an active
 *   coordination state; the system does not downgrade red-state without a human
 *   command)
 * - SUAS-specs SAFETY.md §4 (YELLOW/ORANGE *may* open or update a case; that is
 *   not a must, so this kernel writes nothing for non-RED)
 * - SUAS-specs CASES.md §3 (MVP one non-closed case per veteran), §3.1
 *   (idempotent case-open), §4.0 / §4.2 (REOPEN is a human command; not this
 *   one)
 * - SUAS-specs EVENT_MODEL.md §3 (`CASE_CREATED` on a winning open only)
 *
 * Command: `APPLY_EFFECTIVE_SIGNAL`
 * Idempotency identity: one apply per settled `support_signal_id` (the insert
 * of that row and this write commit in one transaction).
 */

import type { PoolClient } from 'pg';
import {
  findNonClosedCase,
  openCase,
  setCasePrioritySignalLevel,
  type SupportCase,
} from '../coordination/cases.js';
import type { SignalLevel } from './engine.js';
import type { SupportSignal } from './settlement.js';

export type EffectiveSignalCaseAction = 'NONE' | 'OPEN' | 'UPDATE_PRIORITY';

export type EffectiveSignalCaseReason =
  'NON_RED' | 'NO_ACTIVE_CASE' | 'ALREADY_RED' | 'EXISTING_NON_CLOSED_CASE';

export interface EffectiveSignalCaseDecision {
  readonly action: EffectiveSignalCaseAction;
  readonly reason: EffectiveSignalCaseReason;
}

export function decideEffectiveSignalCaseAction(input: {
  readonly level: SignalLevel;
  readonly existingNonClosed?: { readonly prioritySignalLevel?: string };
}): EffectiveSignalCaseDecision {
  if (input.level !== 'RED') {
    return { action: 'NONE', reason: 'NON_RED' };
  }
  if (input.existingNonClosed === undefined) {
    return { action: 'OPEN', reason: 'NO_ACTIVE_CASE' };
  }
  if (input.existingNonClosed.prioritySignalLevel === 'RED') {
    return { action: 'NONE', reason: 'ALREADY_RED' };
  }
  return { action: 'UPDATE_PRIORITY', reason: 'EXISTING_NON_CLOSED_CASE' };
}

export interface ApplyEffectiveSignalResult {
  readonly action: EffectiveSignalCaseAction;
  readonly reason: EffectiveSignalCaseReason;
  readonly supportCase: SupportCase | undefined;
}

/**
 * Apply a settled signal to the veteran's Support Case.
 *
 * RED opens or updates. Non-RED is a no-op, including when a RED case already
 * exists — SAFETY.md §3.2 forbids silent downgrade. CLOSED cases are not in
 * the non-closed projection, so RED opens a new case rather than REOPEN.
 */
export async function applyEffectiveSignal(
  tx: PoolClient,
  signal: SupportSignal,
): Promise<ApplyEffectiveSignalResult> {
  const existing = await findNonClosedCase(tx, signal.tenantId, signal.veteranUserId);
  const decision = decideEffectiveSignalCaseAction({
    level: signal.level,
    ...(existing !== undefined
      ? {
          existingNonClosed: {
            ...(existing.prioritySignalLevel !== undefined
              ? { prioritySignalLevel: existing.prioritySignalLevel }
              : {}),
          },
        }
      : {}),
  });

  if (decision.action === 'NONE') {
    return { ...decision, supportCase: existing };
  }

  if (decision.action === 'OPEN') {
    const opened = await openCase(tx, {
      tenantId: signal.tenantId,
      veteranUserId: signal.veteranUserId,
      prioritySignalLevel: 'RED',
      actorType: 'SYSTEM',
      actorId: 'support-signal',
    });
    if (!opened.created && opened.supportCase.prioritySignalLevel !== 'RED') {
      const updated = await setCasePrioritySignalLevel(
        tx,
        signal.tenantId,
        opened.supportCase.caseId,
        'RED',
      );
      return {
        action: 'UPDATE_PRIORITY',
        reason: 'EXISTING_NON_CLOSED_CASE',
        supportCase: updated,
      };
    }
    return {
      action: opened.created ? 'OPEN' : 'NONE',
      reason: opened.created ? 'NO_ACTIVE_CASE' : 'ALREADY_RED',
      supportCase: opened.supportCase,
    };
  }

  if (existing === undefined) {
    throw new Error('UPDATE_PRIORITY required a non-closed case.');
  }
  const updated = await setCasePrioritySignalLevel(tx, signal.tenantId, existing.caseId, 'RED');
  return { ...decision, supportCase: updated };
}
