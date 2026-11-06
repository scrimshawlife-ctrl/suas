/**
 * Synthetic intake set: invented messages, no real person's data. Each case says
 * what a correct draft looks like. `needs` marks a need outside the four
 * categories, which must get the "not available yet" notice and no draft.
 */

import type { IntakeCategory } from '../../src/intake/tools.js';

export interface IntakeEvalCase {
  readonly id: string;
  readonly text: string;
  /** Category the draft should have, or null when no draft is right. */
  readonly category: IntakeCategory | null;
  /** The need is outside the four categories. */
  readonly outsideCategories?: true;
  /** Lower-case text the draft's timing should contain. */
  readonly timing?: string;
}

export const INTAKE_EVAL_CASES: readonly IntakeEvalCase[] = [
  {
    id: 'food-01',
    text: 'I have not had a real meal in two days and I need groceries.',
    category: 'FOOD',
  },
  {
    id: 'food-02',
    text: 'Could someone help me find a food pantry? I need food by Friday.',
    category: 'FOOD',
    timing: 'friday',
  },
  {
    id: 'food-03',
    text: 'Hungry. Kids are hungry too. Need something to eat tonight.',
    category: 'FOOD',
    timing: 'tonight',
  },
  {
    id: 'food-04',
    text: 'My fridge is empty until my next check in two weeks. I need groceries.',
    category: 'FOOD',
  },
  {
    id: 'ride-01',
    text: 'I need a ride to my VA appointment tomorrow morning.',
    category: 'TRANSPORTATION',
    timing: 'tomorrow',
  },
  {
    id: 'ride-02',
    text: 'My car died and I cannot get to work. I need a ride this week.',
    category: 'TRANSPORTATION',
    timing: 'this week',
  },
  {
    id: 'ride-03',
    text: 'No bus runs near me on Sundays. I need transportation to a clinic on Sunday.',
    category: 'TRANSPORTATION',
    timing: 'sunday',
  },
  {
    id: 'ride-04',
    text: 'Can someone drive me to the pharmacy? I cannot drive after my surgery.',
    category: 'TRANSPORTATION',
  },
  {
    id: 'shelter-01',
    text: 'I got locked out of my apartment and I need a shelter bed tonight.',
    category: 'SHELTER',
    timing: 'tonight',
  },
  {
    id: 'shelter-02',
    text: 'I am sleeping in my truck and need a place to stay for a few nights.',
    category: 'SHELTER',
  },
  {
    id: 'shelter-03',
    text: 'Need emergency shelter for me and my dog starting tomorrow.',
    category: 'SHELTER',
    timing: 'tomorrow',
  },
  {
    id: 'shelter-04',
    text: 'I have nowhere to stay after Saturday.',
    category: 'SHELTER',
    timing: 'saturday',
  },
  {
    id: 'peer-01',
    text: 'I would like to talk with another veteran. I have been feeling alone lately.',
    category: 'PEER_SUPPORT',
  },
  {
    id: 'peer-02',
    text: 'Looking for someone who served to talk to this weekend.',
    category: 'PEER_SUPPORT',
    timing: 'weekend',
  },
  {
    id: 'peer-03',
    text: 'Lonely since I moved here. Want to talk to a fellow veteran.',
    category: 'PEER_SUPPORT',
  },
  {
    id: 'out-01',
    text: 'I need help finding a job and fixing up my resume.',
    category: null,
    outsideCategories: true,
  },
  {
    id: 'out-02',
    text: 'I need a lawyer to help with a legal problem about my lease.',
    category: null,
    outsideCategories: true,
  },
  {
    id: 'out-03',
    text: 'I need a dentist, my tooth hurts and I have no insurance.',
    category: null,
    outsideCategories: true,
  },
  {
    id: 'out-04',
    text: 'Help me with my disability benefits claim paperwork.',
    category: null,
    outsideCategories: true,
  },
  {
    id: 'mixed-01',
    text: 'I need groceries and also help finding a job.',
    category: 'FOOD',
    outsideCategories: true,
  },
  { id: 'unclear-01', text: 'I need help.', category: null },
  { id: 'unclear-02', text: 'Things are hard right now.', category: null },
];
