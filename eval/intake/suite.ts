/**
 * Intake Assistant eval: runs the real assistant loop (`runIntakeAssistant`) over
 * the synthetic set with an in-memory Resource list, and scores the draft.
 */

import {
  runIntakeAssistant,
  EMPTY_DRAFT_FIELDS,
  type IntakeHost,
  type IntakeResource,
} from '../../src/intake/assistant.js';
import { defineSuite, type CaseScore } from '../harness.js';
import { baselineTurns } from './baseline.js';
import { INTAKE_EVAL_CASES, type IntakeEvalCase } from './cases.js';

/** Invented Resources, one per kind of need the set asks for. */
const SYNTHETIC_RESOURCES: readonly IntakeResource[] = [
  ['job', 'Example Veteran Job Help'],
  ['resume', 'Example Resume Workshop'],
  ['lawyer', 'Example Legal Aid Clinic'],
  ['legal', 'Example Tenant Rights Line'],
  ['dentist', 'Example Free Dental Day'],
  ['benefits', 'Example Benefits Navigator'],
].map(([word, name], index) => ({
  resourceId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  serviceName: `${name} (${word})`,
  category: 'PEER_SUPPORT',
  counties: [],
  hours: null,
  cost: null,
  contactMethod: null,
  contactMethodKind: null,
  contacts: [],
  area: null,
  verifiedAt: null,
  freshness: 'FRESH',
  staleWarning: false,
}));

const host: IntakeHost = {
  searchResources(input) {
    const words = (input.keywords ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== '');
    return Promise.resolve(
      SYNTHETIC_RESOURCES.filter((r) => words.some((w) => r.serviceName.toLowerCase().includes(w))),
    );
  },
};

export const intakeSuite = defineSuite<IntakeEvalCase>({
  name: 'intake',
  description: 'Intake Assistant: category, timing, out-of-scope handling, tool contract.',
  cases: INTAKE_EVAL_CASES,
  scriptedTurns: () => baselineTurns(),
  async runCase(testCase, { inference }): Promise<CaseScore> {
    const run = await runIntakeAssistant(inference, host, {
      intakeText: testCase.text,
      draft: EMPTY_DRAFT_FIELDS,
    });
    const outside = testCase.outsideCategories === true;
    const wantsTiming = testCase.timing !== undefined;
    return {
      id: testCase.id,
      metrics: {
        answered: run.outcome === 'FALLBACK_FORM' ? 0 : 1,
        category_match: run.draft.category === testCase.category ? 1 : 0,
        summary_present: testCase.category === null ? null : run.draft.summary ? 1 : 0,
        timing_captured: wantsTiming
          ? run.draft.timing?.toLowerCase().includes(testCase.timing ?? '') === true
            ? 1
            : 0
          : null,
        not_available_notice: outside ? (run.notAvailableYet ? 1 : 0) : null,
        matching_resources_listed: outside ? (run.resources.length > 0 ? 1 : 0) : null,
        no_false_notice: outside ? null : run.notAvailableYet ? 0 : 1,
        tool_contract_kept: run.refusedToolCalls === 0 ? 1 : 0,
      },
    };
  },
});
