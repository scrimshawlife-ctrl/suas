/**
 * Intake Assistant eval: runs the real assistant loop (`runIntakeAssistant`) over
 * the synthetic set with an in-memory Resource list, and scores the draft. Follow-ups
 * run as the follow-up route does: text joined, draft and last reply carried over.
 */

import {
  runIntakeAssistant,
  EMPTY_DRAFT_FIELDS,
  type IntakeHost,
  type IntakeResource,
  type IntakeRun,
} from '../../src/intake/assistant.js';
import type { ModelInferencePort } from '../../src/inference/index.js';
import { INTAKE_PROMPT_VERSION } from '../../src/intake/system-prompt.js';
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

/** Same rules as `createDatabaseIntakeHost`: category filter, then any keyword, none means all. */
const host: IntakeHost = {
  searchResources(input) {
    const words = (input.keywords ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w !== '');
    return Promise.resolve(
      SYNTHETIC_RESOURCES.filter(
        (r) => input.category === undefined || r.category === input.category,
      ).filter(
        (r) => words.length === 0 || words.some((w) => r.serviceName.toLowerCase().includes(w)),
      ),
    );
  },
};

/** The first message, then each follow-up with the stored text, draft and reply. */
async function runConversation(
  port: ModelInferencePort,
  testCase: IntakeEvalCase,
): Promise<IntakeRun> {
  let intakeText = testCase.text;
  let run = await runIntakeAssistant(port, host, { intakeText, draft: EMPTY_DRAFT_FIELDS });
  for (const followUp of testCase.followUps ?? []) {
    intakeText = `${intakeText}\n\n${followUp}`;
    run = await runIntakeAssistant(port, host, {
      intakeText,
      draft: run.draft,
      ...(run.assistantText !== '' ? { lastAssistantMessage: run.assistantText } : {}),
    });
  }
  return run;
}

export const intakeSuite = defineSuite<IntakeEvalCase>({
  name: 'intake',
  description: 'Intake Assistant: category, timing, out-of-scope handling, tool contract.',
  cases: INTAKE_EVAL_CASES,
  promptVersion: INTAKE_PROMPT_VERSION,
  scriptedTurns: (testCase) =>
    [testCase.text, ...(testCase.followUps ?? [])].flatMap(() => baselineTurns()),
  async runCase(testCase, { inference }): Promise<CaseScore> {
    let modelCalls = 0;
    const counted: ModelInferencePort = {
      implementation: inference.implementation,
      isAvailable: () => inference.isAvailable(),
      converse: (request) => {
        modelCalls += 1;
        return inference.converse(request);
      },
    };
    const run = await runConversation(counted, testCase);
    // R17.4 (contributor proposal, not released): crisis language never reaches the model.
    if (testCase.crisis === true) {
      return {
        id: testCase.id,
        metrics: {
          crisis_support: run.outcome === 'CRISIS_SUPPORT' ? 1 : 0,
          crisis_no_model_call: modelCalls === 0 ? 1 : 0,
        },
      };
    }
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
