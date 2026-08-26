/**
 * Released D-011 golden vectors for qv-001 + sv-001.
 *
 * SUAS-specs SIGNAL_SCORING.md B4 (GV-001–GV-014); TESTING.md §12.
 * These are released conformance fixtures, not production-operating evidence.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSignalEngines,
  computeSignal,
  configureSupportSignalScoring,
  MISSING_REQUIRED_SAFETY_INPUT,
  MissingRequiredSafetyInputError,
  QV_001_QUESTIONS,
  QV_001_VERSION,
  SIGNAL_RULE_IDS,
  SignalInputError,
  SignalScoringUnavailableError,
  SV_001_ENGINE,
  SV_001_VERSION,
  type CanonicalSignalInput,
  type SignalLevel,
} from '../../src/signals/index.js';

afterEach(() => {
  clearSignalEngines();
});

/** SIGNAL_SCORING.md B4 complete required-answer baseline A0. */
const A0: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};

function fromAnswers(
  answers: Readonly<Record<string, string>>,
  incomplete = false,
): CanonicalSignalInput {
  return {
    checkInId: 'gv-check-in',
    sourceReference: undefined,
    questionnaireVersion: QV_001_VERSION,
    answers: Object.entries(answers).map(([questionKey, optionKey]) => ({
      questionKey,
      dimension: undefined,
      optionKey,
    })),
    incomplete,
  };
}

function a0With(overrides: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const next: Record<string, string> = { ...A0 };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
  }
  return next;
}

function compute(answers: Readonly<Record<string, string>>, incomplete = false) {
  return computeSignal(SV_001_VERSION, fromAnswers(answers, incomplete));
}

function scores(basis: Record<string, unknown>): Record<string, number> {
  return basis.dimension_scores as Record<string, number>;
}

describe('SIGNAL_SCORING.md B1 — transcribed tables are filled', () => {
  it('registers sv-001 as released and able to handle incomplete input', () => {
    expect(SV_001_ENGINE.signalVersion).toBe('sv-001');
    expect(SV_001_ENGINE.released).toBe(true);
    expect(SV_001_ENGINE.handlesIncompleteInput).toBe(true);
  });

  it('transcribes nine questions, six required, three optional, and every option weight', () => {
    expect(QV_001_QUESTIONS).toHaveLength(9);
    expect(QV_001_QUESTIONS.filter((question) => question.required)).toHaveLength(6);
    expect(QV_001_QUESTIONS.filter((question) => !question.required)).toHaveLength(3);
    const optionCount = QV_001_QUESTIONS.reduce(
      (sum, question) => sum + question.options.length,
      0,
    );
    expect(optionCount).toBe(35);
    for (const question of QV_001_QUESTIONS) {
      expect(question.options.length).toBeGreaterThan(0);
      for (const option of question.options) {
        expect([0, 1, 2, 3]).toContain(option.optionWeight);
        expect(option.optionId.length).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the seven ordered B2 rule identities', () => {
    expect(SIGNAL_RULE_IDS).toEqual([
      'R-RED-01',
      'R-RED-02',
      'R-ORANGE-01',
      'R-ORANGE-02',
      'R-ORANGE-03',
      'R-YELLOW-01',
      'R-GREEN-01',
    ]);
  });
});

describe('SIGNAL_SCORING.md B4 — released golden vectors', () => {
  it('GV-001: A0 is GREEN via R-GREEN-01 with all-zero scores', () => {
    const result = compute(A0);
    expect(result.level).toBe<SignalLevel>('GREEN');
    expect(result.basis.matched_rule_id).toBe('R-GREEN-01');
    expect(scores(result.basis)).toEqual({
      sleep: 0,
      connection: 0,
      stress: 0,
      basic_needs: 0,
      coping: 0,
      safety: 0,
    });
    expect(result.basis.missing_required_question_keys).toEqual([]);
    expect(result.basis.imputed_question_keys).toEqual([]);
    expect(result.basis.questionnaire_version).toBe('qv-001');
    expect(result.basis.signal_version).toBe('sv-001');
  });

  it('GV-002: A0 with sleep A_LITTLE is YELLOW via R-YELLOW-01', () => {
    const result = compute(a0With({ sleep_manage_7d: 'A_LITTLE' }));
    expect(result.level).toBe('YELLOW');
    expect(result.basis.matched_rule_id).toBe('R-YELLOW-01');
    expect(scores(result.basis).sleep).toBe(1);
    expect(scores(result.basis)).toMatchObject({
      connection: 0,
      stress: 0,
      basic_needs: 0,
      coping: 0,
      safety: 0,
    });
  });

  it('GV-003: A0 with basic_needs IMPORTANT_GAP is YELLOW via R-YELLOW-01', () => {
    const result = compute(a0With({ basic_needs_48h: 'IMPORTANT_GAP' }));
    expect(result.level).toBe('YELLOW');
    expect(result.basis.matched_rule_id).toBe('R-YELLOW-01');
    expect(scores(result.basis).basic_needs).toBe(2);
  });

  it('GV-004: two non-safety dimensions at 2 is ORANGE via R-ORANGE-03', () => {
    const result = compute(
      a0With({
        stress_manage_7d: 'A_LOT',
        reliable_connection_now: 'BARELY_CONNECTED',
      }),
    );
    expect(result.level).toBe('ORANGE');
    expect(result.basis.matched_rule_id).toBe('R-ORANGE-03');
    expect(scores(result.basis).stress).toBe(2);
    expect(scores(result.basis).connection).toBe(2);
  });

  it('GV-005: basic_needs IMMEDIATE_NEED is ORANGE via R-ORANGE-02', () => {
    const result = compute(a0With({ basic_needs_48h: 'IMMEDIATE_NEED' }));
    expect(result.level).toBe('ORANGE');
    expect(result.basis.matched_rule_id).toBe('R-ORANGE-02');
    expect(scores(result.basis).basic_needs).toBe(3);
  });

  it('GV-006: safe_now NO_SUPPORT_SOON is ORANGE via R-ORANGE-01', () => {
    const result = compute(a0With({ safe_now: 'NO_SUPPORT_SOON' }));
    expect(result.level).toBe('ORANGE');
    expect(result.basis.matched_rule_id).toBe('R-ORANGE-01');
    expect(scores(result.basis).safety).toBe(2);
  });

  it('GV-007: safe_now NO_IMMEDIATE_HELP is RED via R-RED-01', () => {
    const result = compute(a0With({ safe_now: 'NO_IMMEDIATE_HELP' }));
    expect(result.level).toBe('RED');
    expect(result.basis.matched_rule_id).toBe('R-RED-01');
    expect(scores(result.basis).safety).toBe(3);
  });

  it('GV-008: A0 plus immediate_danger YES is RED via R-RED-02', () => {
    const result = compute(a0With({ immediate_danger: 'YES' }));
    expect(result.level).toBe('RED');
    expect(result.basis.matched_rule_id).toBe('R-RED-02');
    expect(scores(result.basis).safety).toBe(3);
  });

  it('GV-009: missing required safety refuses and persists no basis', () => {
    expect(() => compute(a0With({ safe_now: undefined }), true)).toThrow(
      MissingRequiredSafetyInputError,
    );
    try {
      compute(a0With({ safe_now: undefined }), true);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingRequiredSafetyInputError);
      expect((error as MissingRequiredSafetyInputError).code).toBe(MISSING_REQUIRED_SAFETY_INPUT);
      expect(JSON.stringify(error)).not.toContain('dimension_scores');
    }
  });

  it('GV-010: missing required sleep imputes weight 2 and is YELLOW', () => {
    const result = compute(a0With({ sleep_manage_7d: undefined }), true);
    expect(result.level).toBe('YELLOW');
    expect(result.basis.matched_rule_id).toBe('R-YELLOW-01');
    expect(scores(result.basis).sleep).toBe(2);
    expect(result.basis.missing_required_question_keys).toEqual(['sleep_manage_7d']);
    expect(result.basis.imputed_question_keys).toEqual(['sleep_manage_7d']);
  });

  it('GV-011: two imputed non-safety dimensions are ORANGE via R-ORANGE-03', () => {
    const result = compute(
      a0With({ sleep_manage_7d: undefined, stress_manage_7d: undefined }),
      true,
    );
    expect(result.level).toBe('ORANGE');
    expect(result.basis.matched_rule_id).toBe('R-ORANGE-03');
    expect(scores(result.basis).sleep).toBe(2);
    expect(scores(result.basis).stress).toBe(2);
    expect(result.basis.missing_required_question_keys).toEqual([
      'sleep_manage_7d',
      'stress_manage_7d',
    ]);
    expect(result.basis.imputed_question_keys).toEqual(['sleep_manage_7d', 'stress_manage_7d']);
  });

  it('GV-012: optional basic_need_urgency TODAY raises basic_needs to 3', () => {
    const result = compute(a0With({ basic_need_urgency: 'TODAY' }));
    expect(result.level).toBe('ORANGE');
    expect(result.basis.matched_rule_id).toBe('R-ORANGE-02');
    expect(scores(result.basis).basic_needs).toBe(3);
  });

  it('GV-013: unanswered optional questions match GV-001 and are not imputed', () => {
    const result = compute(A0);
    expect(result.level).toBe('GREEN');
    expect(result.basis.matched_rule_id).toBe('R-GREEN-01');
    expect(result.basis.missing_required_question_keys).toEqual([]);
    expect(result.basis.imputed_question_keys).toEqual([]);
    expect(result.basis.answers).not.toHaveProperty('basic_need_urgency');
    expect(result.basis.answers).not.toHaveProperty('support_reachable');
    expect(result.basis.answers).not.toHaveProperty('immediate_danger');
  });

  it('GV-014: explicit safety conflict resolves by precedence to R-RED-02', () => {
    const result = compute(a0With({ immediate_danger: 'YES' }));
    expect(result.level).toBe('RED');
    expect(result.basis.matched_rule_id).toBe('R-RED-02');
  });
});

describe('SIGNAL_SCORING.md B2 — minimized basis and determinism', () => {
  it('repeats the same level and semantically equivalent basis', () => {
    const first = compute(a0With({ sleep_manage_7d: 'A_LITTLE' }));
    const second = compute(a0With({ sleep_manage_7d: 'A_LITTLE' }));
    expect(second).toEqual(first);
  });

  it('omits prompts, labels, and free text from basis', () => {
    const result = compute(A0);
    const serialized = JSON.stringify(result.basis);
    expect(serialized).not.toContain('During the past 7 days');
    expect(serialized).not.toContain('Well connected');
    expect(serialized).not.toContain('free_text');
    expect(serialized).not.toContain('transition');
    expect(Object.keys(result.basis).sort()).toEqual(
      [
        'answers',
        'dimension_scores',
        'imputed_question_keys',
        'matched_rule_id',
        'missing_required_question_keys',
        'questionnaire_version',
        'signal_version',
      ].sort(),
    );
  });
});

describe('SIGNAL_SCORING.md B5 — exact questionnaire identity', () => {
  it('rejects an absent questionnaireVersion', () => {
    const input = fromAnswers(A0);
    expect(() =>
      computeSignal(SV_001_VERSION, { ...input, questionnaireVersion: undefined }),
    ).toThrow(SignalInputError);
    try {
      computeSignal(SV_001_VERSION, { ...input, questionnaireVersion: undefined });
    } catch (error) {
      expect(error).toBeInstanceOf(SignalInputError);
      expect((error as SignalInputError).message).toContain('absent');
    }
  });

  it('rejects a mismatched questionnaireVersion', () => {
    const input = fromAnswers(A0);
    expect(() =>
      computeSignal(SV_001_VERSION, { ...input, questionnaireVersion: 'qv-other' }),
    ).toThrow(SignalInputError);
  });
});

describe('ENVIRONMENT.md §3 — disabled mode refuses scoring', () => {
  it('refuses computeSignal when the process mode is disabled', () => {
    configureSupportSignalScoring('disabled');
    expect(() => compute(A0)).toThrow(SignalScoringUnavailableError);
  });

  it('refuses computeSignal when the call passes disabled explicitly', () => {
    expect(() =>
      computeSignal(SV_001_VERSION, fromAnswers(A0), { supportSignalMode: 'disabled' }),
    ).toThrow(SignalScoringUnavailableError);
  });

  it('still scores under fixture mode', () => {
    configureSupportSignalScoring('fixture');
    expect(compute(A0).level).toBe('GREEN');
  });
});
