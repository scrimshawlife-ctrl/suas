/**
 * G-I-28 / SAFETY.md §3.2 — signal-driven Support Case action policy.
 *
 * Transcribed from released SAFETY.md: an effective RED must open or update a
 * case; YELLOW/ORANGE "may" is not a must, so the kernel fails closed; CLOSED
 * is not an active coordination state, so a new case is opened rather than
 * REOPEN (REOPEN remains a human command).
 */

import { describe, expect, it } from 'vitest';
import { decideEffectiveSignalCaseAction } from '../../src/signals/case-action.js';

describe('SAFETY.md §3.2 / G-I-28 — APPLY_EFFECTIVE_SIGNAL policy', () => {
  it('opens a case for RED when none is non-closed', () => {
    expect(decideEffectiveSignalCaseAction({ level: 'RED' })).toEqual({
      action: 'OPEN',
      reason: 'NO_ACTIVE_CASE',
    });
  });

  it('updates priority when a non-closed case is not already RED', () => {
    expect(
      decideEffectiveSignalCaseAction({
        level: 'RED',
        existingNonClosed: { prioritySignalLevel: 'YELLOW' },
      }),
    ).toEqual({
      action: 'UPDATE_PRIORITY',
      reason: 'EXISTING_NON_CLOSED_CASE',
    });
  });

  it('is a no-op when the non-closed case is already RED', () => {
    expect(
      decideEffectiveSignalCaseAction({
        level: 'RED',
        existingNonClosed: { prioritySignalLevel: 'RED' },
      }),
    ).toEqual({
      action: 'NONE',
      reason: 'ALREADY_RED',
    });
  });

  it.each(['GREEN', 'YELLOW', 'ORANGE'] as const)(
    'does not write a case from an effective %s signal',
    (level) => {
      expect(
        decideEffectiveSignalCaseAction({
          level,
          existingNonClosed: { prioritySignalLevel: 'GREEN' },
        }),
      ).toEqual({ action: 'NONE', reason: 'NON_RED' });
    },
  );

  it('does not treat a CLOSED case as existing — RED opens a new case', () => {
    // CLOSED is excluded from the non-closed projection by the caller.
    expect(decideEffectiveSignalCaseAction({ level: 'RED' }).action).toBe('OPEN');
  });

  it('does not downgrade an existing RED case from a later non-RED signal', () => {
    expect(
      decideEffectiveSignalCaseAction({
        level: 'GREEN',
        existingNonClosed: { prioritySignalLevel: 'RED' },
      }),
    ).toEqual({ action: 'NONE', reason: 'NON_RED' });
  });
});
