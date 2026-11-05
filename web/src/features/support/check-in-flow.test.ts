import { describe, expect, it } from 'vitest';
import {
  firstMissingRequired,
  previousQuestion,
  recordAnswer,
  skipQuestion,
  START,
  type Question,
} from './check-in-flow';

function q(id: string, required: boolean): Question {
  return {
    question_id: id,
    question_key: id,
    prompt: id,
    dimension: null,
    required,
    options: [{ answer_option_id: `${id}-a`, option_key: 'A', label: 'A' }],
  };
}

const questions = [q('q1', true), q('q2', false), q('q3', true)];

describe('Check-In step flow', () => {
  it('moves one question at a time and records each answer', () => {
    const first = recordAnswer(questions, START, 'q1-a');
    expect(first.done).toBe(false);
    expect(first.position).toEqual({ index: 1, answers: { q1: 'q1-a' } });
    const second = recordAnswer(questions, first.position, 'q2-a');
    expect(second.position.index).toBe(2);
  });

  it('reports done on the last answer and stays on that question', () => {
    const last = recordAnswer(questions, { index: 2, answers: { q1: 'q1-a' } }, 'q3-a');
    expect(last.done).toBe(true);
    expect(last.position.index).toBe(2);
    expect(last.position.answers).toEqual({ q1: 'q1-a', q3: 'q3-a' });
  });

  it('goes back without losing answers, and not before the first question', () => {
    const back = previousQuestion({ index: 1, answers: { q1: 'q1-a' } });
    expect(back).toEqual({ index: 0, answers: { q1: 'q1-a' } });
    expect(previousQuestion(START).index).toBe(0);
  });

  it('skips an optional question without recording an answer', () => {
    const skipped = skipQuestion(questions, { index: 1, answers: { q1: 'q1-a' } });
    expect(skipped.position).toEqual({ index: 2, answers: { q1: 'q1-a' } });
    expect(skipped.done).toBe(false);
  });

  it('finds the first required question still unanswered', () => {
    expect(firstMissingRequired(questions, { q1: 'q1-a' })).toBe(2);
    expect(firstMissingRequired(questions, {})).toBe(0);
    expect(firstMissingRequired(questions, { q1: 'x', q3: 'y' })).toBeNull();
  });
});
