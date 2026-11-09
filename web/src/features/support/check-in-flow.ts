import type { CheckInWithQuestions } from './api';

export type Question = CheckInWithQuestions['questions'][number];

/** Answers by question id (the chosen answer option id). */
export type Answers = Readonly<Record<string, string>>;

export interface Position {
  /** Zero based index of the question on screen. */
  index: number;
  answers: Answers;
}

export const START: Position = { index: 0, answers: {} };

export function isLast(questions: readonly Question[], index: number): boolean {
  return index >= questions.length - 1;
}

/** Record an answer for the question on screen and move on. `done` is true after the last one. */
export function recordAnswer(
  questions: readonly Question[],
  position: Position,
  optionId: string,
): { position: Position; done: boolean } {
  const question = questions[position.index];
  if (question === undefined) return { position, done: true };
  const answers = { ...position.answers, [question.question_id]: optionId };
  const done = isLast(questions, position.index);
  return { position: { index: done ? position.index : position.index + 1, answers }, done };
}

/** Move past an optional question without answering it. */
export function skipQuestion(
  questions: readonly Question[],
  position: Position,
): { position: Position; done: boolean } {
  const done = isLast(questions, position.index);
  return {
    position: { ...position, index: done ? position.index : position.index + 1 },
    done,
  };
}

export function previousQuestion(position: Position): Position {
  return { ...position, index: Math.max(0, position.index - 1) };
}

/**
 * Where a resumed Check-In opens: the first question with no saved answer, or the last
 * question when every one is answered. The server keeps ids, not choices, so `answers` is empty.
 */
export function resumePosition(
  questions: readonly Question[],
  answeredQuestionIds: readonly string[],
): Position {
  const answered = new Set(answeredQuestionIds);
  const first = questions.findIndex((question) => !answered.has(question.question_id));
  const index = first === -1 ? Math.max(0, questions.length - 1) : first;
  return { index, answers: {} };
}
