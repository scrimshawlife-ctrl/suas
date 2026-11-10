/**
 * The Crisis triage result per answer. Every sentence below is copied from the Crisis or Home
 * boards (D-012 copy). Do not add new crisis wording here.
 */
export type TriageAnswer = 'yes' | 'no' | 'unsure';

/** `text838255` is the D-050 Veterans Crisis Line text action (SAFETY_COPY.md §1.4, §1.5). */
export type CrisisButton = 'call911' | 'call988' | 'text838255' | 'continue';

export interface CrisisResult {
  heading: string;
  /** Plain text paragraphs; the exact text "988" is rendered bold by the page. */
  paragraphs: string[];
  buttons: CrisisButton[];
}

export const TRIAGE_OPTIONS: readonly {
  value: TriageAnswer;
  title: string;
  description: string;
}[] = [
  {
    value: 'yes',
    title: 'Yes, immediate danger',
    description:
      'Someone may be seriously injured, is experiencing a medical emergency, or may harm themselves or someone else.',
  },
  {
    value: 'no',
    title: 'No, urgent support needed',
    description: 'The situation is serious, but there is no immediate threat to life or safety.',
  },
  {
    value: 'unsure',
    title: 'Not sure',
    description: 'I cannot determine whether the situation is immediately dangerous.',
  },
];

const CALL_911 = 'If you believe there may be an immediate threat to life or safety, call 911.';
const CALL_988 =
  'For suicidal thoughts, emotional distress, or a mental health crisis, call or text 988.';
const NO_DANGER =
  'If there is no immediate danger, SUAS can help identify the practical support you need.';
const EMERGENCY =
  'If you are in immediate danger, have a medical emergency, or believe someone may be seriously harmed, call 911 or go to the nearest emergency department.';
const NOT_EMERGENCY_SERVICE =
  'SUAS coordinates practical support. It is not an emergency service and cannot replace police, fire, EMS, or emergency medical care.';

export function crisisResult(answer: TriageAnswer): CrisisResult {
  switch (answer) {
    case 'yes':
      return {
        heading: 'Yes, immediate danger',
        paragraphs: [EMERGENCY, CALL_988, NOT_EMERGENCY_SERVICE],
        buttons: ['call911', 'call988', 'text838255'],
      };
    case 'no':
      return {
        heading: 'No, urgent support needed',
        paragraphs: [
          'The situation is serious, but there is no immediate threat to life or safety.',
          CALL_911,
          CALL_988,
          NO_DANGER,
        ],
        buttons: ['call911', 'call988', 'continue'],
      };
    case 'unsure':
      return {
        heading: 'If you are unsure, treat immediate safety first.',
        paragraphs: [CALL_911, CALL_988, NO_DANGER],
        buttons: ['call911', 'call988', 'text838255', 'continue'],
      };
  }
}
