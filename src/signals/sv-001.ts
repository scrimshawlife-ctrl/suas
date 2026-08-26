/**
 * Released Support Signal engine for `qv-001` + `sv-001`.
 *
 * Spec citations:
 * - SUAS-specs SIGNAL_SCORING.md B1 (questionnaire content and option weights)
 * - SUAS-specs SIGNAL_SCORING.md B2 (dimension-maximum map and ordered rules)
 * - SUAS-specs SIGNAL_SCORING.md B3 (incomplete-input function)
 * - SUAS-specs SIGNAL_SCORING.md B4 (golden vectors GV-001–GV-014)
 * - SUAS-specs SIGNAL_SCORING.md B5 (version identities)
 * - SUAS-specs RELEASE_DECISIONS-0.2.0.md D-011
 * - SUAS-specs RELEASE_MANIFEST-0.2.0.md "Runtime pins"
 *
 * This module transcribes the released tables. It does not invent a weight,
 * question, or rule. Free text is not a field on CanonicalSignalInput and is
 * never read. No generative model participates.
 */

import type { JsonObject } from '../jobs/index.js';
import type {
  CanonicalAnswer,
  CanonicalSignalInput,
  SignalComputation,
  SignalEngine,
  SignalLevel,
} from './engine.js';
import { assertSupportSignalScoringEnabled } from './scoring-mode.js';

/** SIGNAL_SCORING.md B1 / CHECKINS.md §3. Exactly these six dimensions. */
export const QV_001_DIMENSIONS = [
  'sleep',
  'connection',
  'stress',
  'basic_needs',
  'coping',
  'safety',
] as const;
export type Qv001Dimension = (typeof QV_001_DIMENSIONS)[number];

export const QV_001_VERSION = 'qv-001' as const;
export const SV_001_VERSION = 'sv-001' as const;

export const SIGNAL_RULE_IDS = [
  'R-RED-01',
  'R-RED-02',
  'R-ORANGE-01',
  'R-ORANGE-02',
  'R-ORANGE-03',
  'R-YELLOW-01',
  'R-GREEN-01',
] as const;
export type SignalRuleId = (typeof SIGNAL_RULE_IDS)[number];

export const MISSING_REQUIRED_SAFETY_INPUT = 'MISSING_REQUIRED_SAFETY_INPUT' as const;

/** B3 imputation weight for a missing required non-safety question. */
export const IMPUTED_REQUIRED_NON_SAFETY_WEIGHT = 2 as const;

export interface ReleasedOption {
  readonly optionId: string;
  readonly optionLabel: string;
  readonly optionWeight: 0 | 1 | 2 | 3;
}

export interface ReleasedQuestion {
  readonly questionKey: string;
  readonly prompt: string;
  readonly required: boolean;
  readonly dimension: Qv001Dimension;
  readonly options: readonly ReleasedOption[];
}

/**
 * SIGNAL_SCORING.md B1 — exact `qv-001` content.
 *
 * Option weights are the only numbers this engine may use.
 */
export const QV_001_QUESTIONS: readonly ReleasedQuestion[] = [
  {
    questionKey: 'sleep_manage_7d',
    prompt: 'During the past 7 days, how much has sleep made it harder to manage your daily needs?',
    required: true,
    dimension: 'sleep',
    options: [
      { optionId: 'NOT_AT_ALL', optionLabel: 'Not at all', optionWeight: 0 },
      { optionId: 'A_LITTLE', optionLabel: 'A little', optionWeight: 1 },
      { optionId: 'A_LOT', optionLabel: 'A lot', optionWeight: 2 },
      {
        optionId: 'UNABLE_TO_MANAGE',
        optionLabel: 'I have been unable to manage',
        optionWeight: 3,
      },
    ],
  },
  {
    questionKey: 'reliable_connection_now',
    prompt: 'How connected do you feel to people or services you can rely on right now?',
    required: true,
    dimension: 'connection',
    options: [
      { optionId: 'WELL_CONNECTED', optionLabel: 'Well connected', optionWeight: 0 },
      { optionId: 'SOMEWHAT_CONNECTED', optionLabel: 'Somewhat connected', optionWeight: 1 },
      { optionId: 'BARELY_CONNECTED', optionLabel: 'Barely connected', optionWeight: 2 },
      { optionId: 'NOT_CONNECTED', optionLabel: 'Not connected', optionWeight: 3 },
    ],
  },
  {
    questionKey: 'stress_manage_7d',
    prompt:
      'During the past 7 days, how much has stress made it harder to handle what needs your attention?',
    required: true,
    dimension: 'stress',
    options: [
      { optionId: 'NOT_AT_ALL', optionLabel: 'Not at all', optionWeight: 0 },
      { optionId: 'A_LITTLE', optionLabel: 'A little', optionWeight: 1 },
      { optionId: 'A_LOT', optionLabel: 'A lot', optionWeight: 2 },
      {
        optionId: 'UNABLE_TO_MANAGE',
        optionLabel: 'I have been unable to manage',
        optionWeight: 3,
      },
    ],
  },
  {
    questionKey: 'basic_needs_48h',
    prompt:
      'How secure are your food, shelter, transportation, and essential supplies for the next 48 hours?',
    required: true,
    dimension: 'basic_needs',
    options: [
      { optionId: 'SECURE', optionLabel: 'Secure', optionWeight: 0 },
      {
        optionId: 'ONE_MANAGEABLE_CONCERN',
        optionLabel: 'One manageable concern',
        optionWeight: 1,
      },
      { optionId: 'IMPORTANT_GAP', optionLabel: 'An important gap', optionWeight: 2 },
      { optionId: 'IMMEDIATE_NEED', optionLabel: 'An immediate need', optionWeight: 3 },
    ],
  },
  {
    questionKey: 'basic_need_urgency',
    prompt: 'How soon do you need help with your most important basic need?',
    required: false,
    dimension: 'basic_needs',
    options: [
      { optionId: 'NO_HELP_NEEDED', optionLabel: 'No help needed', optionWeight: 0 },
      { optionId: 'AFTER_48_HOURS', optionLabel: 'After 48 hours', optionWeight: 1 },
      { optionId: 'WITHIN_48_HOURS', optionLabel: 'Within 48 hours', optionWeight: 2 },
      { optionId: 'TODAY', optionLabel: 'Today', optionWeight: 3 },
    ],
  },
  {
    questionKey: 'coping_24h',
    prompt:
      'How able do you feel to get through the next 24 hours with the support available to you?',
    required: true,
    dimension: 'coping',
    options: [
      { optionId: 'ABLE', optionLabel: 'Able', optionWeight: 0 },
      { optionId: 'MOSTLY_ABLE', optionLabel: 'Mostly able', optionWeight: 1 },
      { optionId: 'STRUGGLING', optionLabel: 'Struggling', optionWeight: 2 },
      { optionId: 'UNABLE', optionLabel: 'Unable', optionWeight: 3 },
    ],
  },
  {
    questionKey: 'support_reachable',
    prompt: 'If things become harder, can you reach a person or service that can support you?',
    required: false,
    dimension: 'coping',
    options: [
      { optionId: 'YES', optionLabel: 'Yes', optionWeight: 0 },
      { optionId: 'PROBABLY', optionLabel: 'Probably', optionWeight: 1 },
      { optionId: 'NOT_SURE', optionLabel: 'Not sure', optionWeight: 2 },
      { optionId: 'NO', optionLabel: 'No', optionWeight: 3 },
    ],
  },
  {
    questionKey: 'safe_now',
    prompt: 'Do you feel safe right now?',
    required: true,
    dimension: 'safety',
    options: [
      { optionId: 'YES', optionLabel: 'Yes', optionWeight: 0 },
      {
        optionId: 'MOSTLY_WITH_CONCERN',
        optionLabel: 'Mostly, but I have a concern',
        optionWeight: 1,
      },
      { optionId: 'NO_SUPPORT_SOON', optionLabel: 'No; I need support soon', optionWeight: 2 },
      { optionId: 'NO_IMMEDIATE_HELP', optionLabel: 'No; I need immediate help', optionWeight: 3 },
    ],
  },
  {
    questionKey: 'immediate_danger',
    prompt: 'Are you in immediate danger or do you need emergency help now?',
    required: false,
    dimension: 'safety',
    options: [
      { optionId: 'NO', optionLabel: 'No', optionWeight: 0 },
      { optionId: 'NOT_SURE', optionLabel: 'Not sure', optionWeight: 2 },
      { optionId: 'YES', optionLabel: 'Yes', optionWeight: 3 },
    ],
  },
];

export class MissingRequiredSafetyInputError extends Error {
  readonly code = MISSING_REQUIRED_SAFETY_INPUT;
  readonly httpStatus = 422;

  constructor() {
    super(
      'Support Signal computation refused: a required safety question is missing ' +
        `(${MISSING_REQUIRED_SAFETY_INPUT}). No Support Signal is persisted ` +
        '(SUAS-specs SIGNAL_SCORING.md B3).',
    );
    this.name = 'MissingRequiredSafetyInputError';
  }
}

export class SignalInputError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(message: string) {
    super(message);
    this.name = 'SignalInputError';
  }
}

function answeredOptionId(
  answers: readonly CanonicalAnswer[],
  questionKey: string,
): string | undefined {
  const match = answers.find((answer) => answer.questionKey === questionKey);
  if (match === undefined) return undefined;
  const optionId = match.optionKey?.trim();
  return optionId === undefined || optionId === '' ? undefined : optionId;
}

function optionWeight(question: ReleasedQuestion, optionId: string): 0 | 1 | 2 | 3 {
  const option = question.options.find((entry) => entry.optionId === optionId);
  if (option === undefined) {
    throw new SignalInputError(
      `Question "${question.questionKey}" has no released option "${optionId}" ` +
        '(SUAS-specs SIGNAL_SCORING.md B1).',
    );
  }
  return option.optionWeight;
}

function firstMatchingRule(
  optionByQuestion: ReadonlyMap<string, string>,
  dimensionScores: Readonly<Record<Qv001Dimension, number>>,
): SignalRuleId {
  if (optionByQuestion.get('safe_now') === 'NO_IMMEDIATE_HELP') return 'R-RED-01';
  if (optionByQuestion.get('immediate_danger') === 'YES') return 'R-RED-02';
  if (dimensionScores.safety === 2) return 'R-ORANGE-01';
  const nonSafetyScores = QV_001_DIMENSIONS.filter((dimension) => dimension !== 'safety').map(
    (dimension) => dimensionScores[dimension],
  );
  if (nonSafetyScores.some((score) => score === 3)) return 'R-ORANGE-02';
  const highCount = QV_001_DIMENSIONS.filter((dimension) => dimensionScores[dimension] >= 2).length;
  if (highCount >= 2) return 'R-ORANGE-03';
  if (
    QV_001_DIMENSIONS.some((dimension) => {
      const score = dimensionScores[dimension];
      return score === 1 || score === 2;
    })
  ) {
    return 'R-YELLOW-01';
  }
  if (QV_001_DIMENSIONS.every((dimension) => dimensionScores[dimension] === 0)) {
    return 'R-GREEN-01';
  }
  throw new SignalInputError(
    'No released SIGNAL_SCORING.md B2 rule matched the computed dimension scores.',
  );
}

function levelForRule(ruleId: SignalRuleId): SignalLevel {
  if (ruleId === 'R-RED-01' || ruleId === 'R-RED-02') return 'RED';
  if (ruleId === 'R-ORANGE-01' || ruleId === 'R-ORANGE-02' || ruleId === 'R-ORANGE-03') {
    return 'ORANGE';
  }
  if (ruleId === 'R-YELLOW-01') return 'YELLOW';
  return 'GREEN';
}

/**
 * Pure `sv-001` computation. SIGNAL_SCORING.md B2–B3.
 *
 * Same canonical answers and versions produce the same level and a semantically
 * equivalent basis. Missing required safety input throws and returns no basis.
 */
export function computeSv001(input: CanonicalSignalInput): SignalComputation {
  // ENVIRONMENT.md §3: disabled mode must refuse every application-exported path,
  // including this helper and SV_001_ENGINE.compute (not only computeSignal).
  assertSupportSignalScoringEnabled();

  // B5: scoring identity is exact qv-001. Absent, unknown, and mismatched versions
  // all refuse — there is no implicit default questionnaire.
  if (input.questionnaireVersion !== QV_001_VERSION) {
    const received =
      input.questionnaireVersion === undefined || input.questionnaireVersion === ''
        ? 'absent'
        : `"${input.questionnaireVersion}"`;
    throw new SignalInputError(
      `sv-001 scores only questionnaire_version ${QV_001_VERSION} ` +
        `(received ${received}; SIGNAL_SCORING.md B5).`,
    );
  }

  const optionByQuestion = new Map<string, string>();
  for (const question of QV_001_QUESTIONS) {
    const optionId = answeredOptionId(input.answers, question.questionKey);
    if (optionId !== undefined) {
      // Validate against the released table before using the weight.
      optionWeight(question, optionId);
      optionByQuestion.set(question.questionKey, optionId);
    }
  }

  const requiredSafetyMissing = QV_001_QUESTIONS.filter(
    (question) =>
      question.required &&
      question.dimension === 'safety' &&
      !optionByQuestion.has(question.questionKey),
  ).map((question) => question.questionKey);
  if (requiredSafetyMissing.length > 0) {
    throw new MissingRequiredSafetyInputError();
  }

  const missingRequired = QV_001_QUESTIONS.filter(
    (question) => question.required && !optionByQuestion.has(question.questionKey),
  ).map((question) => question.questionKey);
  const imputed = [...missingRequired];

  const dimensionScores = Object.fromEntries(
    QV_001_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as Record<Qv001Dimension, number>;

  for (const question of QV_001_QUESTIONS) {
    const optionId = optionByQuestion.get(question.questionKey);
    if (optionId !== undefined) {
      const weight = optionWeight(question, optionId);
      dimensionScores[question.dimension] = Math.max(dimensionScores[question.dimension], weight);
      continue;
    }
    if (question.required) {
      dimensionScores[question.dimension] = Math.max(
        dimensionScores[question.dimension],
        IMPUTED_REQUIRED_NON_SAFETY_WEIGHT,
      );
    }
  }

  const matchedRuleId = firstMatchingRule(optionByQuestion, dimensionScores);
  const answers: Record<string, string> = {};
  for (const [questionKey, optionId] of [...optionByQuestion.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    answers[questionKey] = optionId;
  }

  const basis: JsonObject = {
    questionnaire_version: QV_001_VERSION,
    signal_version: SV_001_VERSION,
    answers,
    missing_required_question_keys: [...missingRequired].sort(),
    imputed_question_keys: [...imputed].sort(),
    dimension_scores: {
      sleep: dimensionScores.sleep,
      connection: dimensionScores.connection,
      stress: dimensionScores.stress,
      basic_needs: dimensionScores.basic_needs,
      coping: dimensionScores.coping,
      safety: dimensionScores.safety,
    },
    matched_rule_id: matchedRuleId,
  };

  return {
    level: levelForRule(matchedRuleId),
    basis,
  };
}

export const SV_001_ENGINE: SignalEngine = {
  signalVersion: SV_001_VERSION,
  released: true,
  handlesIncompleteInput: true,
  compute: computeSv001,
};
