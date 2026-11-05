/**
 * Eval harness (V1_PROJECT_PLAN.md F11): a suite is a list of synthetic cases, a
 * way to run one case against the configured inference adapter, and a score per
 * case. The runner aggregates and prints; it never gates (gates are undecided,
 * plan §8 item 13).
 *
 * Adding a suite (for example Resource extraction):
 *   1. Put synthetic cases (no real people or real organizations' private data)
 *      under `eval/<suite>/`.
 *   2. Export a `defineSuite({...})` from `eval/<suite>/suite.ts`.
 *   3. Add it to the array in `eval/suites.ts`.
 *   `npm run eval` then runs it.
 *
 * Adapters. With `SUAS_MODEL_INFERENCE_MODE=fake` the context holds a
 * fresh `ScriptedModelInference` per case. Before each case the runner queues
 * `suite.scriptedTurns(case)` on it, so the fake answers like a simple baseline
 * and the harness runs end to end in CI. Those scores check the harness and the
 * scoring; they say nothing about a model. With `bedrock` the real adapter runs
 * and `scriptedTurns` is ignored.
 */

import {
  ScriptedModelInference,
  type ModelInferencePort,
  type ScriptedTurn,
} from '../src/inference/index.js';

export interface EvalContext {
  /** A fresh scripted fake per case, or the one real adapter. */
  readonly inference: ModelInferencePort;
}

/** Builds the adapter for one case. The runner calls it once per case. */
export type InferenceFactory = () => ModelInferencePort;

/**
 * One case's result. Each metric is a number from 0 to 1, or null when the metric
 * does not apply to this case (it is then left out of that metric's mean).
 */
export interface CaseScore {
  readonly id: string;
  readonly metrics: Readonly<Record<string, number | null>>;
}

export interface EvalSuite<TCase extends { readonly id: string }> {
  readonly name: string;
  readonly description: string;
  readonly cases: readonly TCase[];
  /** Fake-adapter answer for a case. Ignored when the real adapter is configured. */
  scriptedTurns?(testCase: TCase): readonly ScriptedTurn[];
  runCase(testCase: TCase, context: EvalContext): Promise<CaseScore>;
}

/** A suite with its case type erased, so suites of different case types share one list. */
export interface RunnableSuite {
  readonly name: string;
  readonly description: string;
  run(makeInference: InferenceFactory): Promise<SuiteReport>;
}

/** Keeps a suite's case type checked, then erases it for `eval/suites.ts`. */
export function defineSuite<TCase extends { readonly id: string }>(
  suite: EvalSuite<TCase>,
): RunnableSuite {
  return {
    name: suite.name,
    description: suite.description,
    run: (makeInference) => runSuite(suite, makeInference),
  };
}

export interface SuiteReport {
  readonly suite: string;
  readonly description: string;
  readonly cases: number;
  /** Mean per metric over the cases it applied to. */
  readonly metrics: Readonly<Record<string, { readonly mean: number; readonly applied: number }>>;
  /** Cases that threw instead of scoring. A thrown case counts as a harness defect. */
  readonly errors: readonly { readonly id: string; readonly message: string }[];
}

export function aggregate(
  suite: { readonly name: string; readonly description: string },
  scores: readonly CaseScore[],
  errors: SuiteReport['errors'],
): SuiteReport {
  const sums = new Map<string, { total: number; applied: number }>();
  for (const score of scores) {
    for (const [metric, value] of Object.entries(score.metrics)) {
      const entry = sums.get(metric) ?? { total: 0, applied: 0 };
      if (value !== null) {
        entry.total += value;
        entry.applied += 1;
      }
      sums.set(metric, entry);
    }
  }
  const metrics: Record<string, { mean: number; applied: number }> = {};
  for (const [metric, { total, applied }] of [...sums.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    metrics[metric] = { mean: applied === 0 ? 0 : total / applied, applied };
  }
  return {
    suite: suite.name,
    description: suite.description,
    cases: scores.length + errors.length,
    metrics,
    errors,
  };
}

export async function runSuite<TCase extends { readonly id: string }>(
  suite: EvalSuite<TCase>,
  makeInference: InferenceFactory,
): Promise<SuiteReport> {
  const scores: CaseScore[] = [];
  const errors: { id: string; message: string }[] = [];
  for (const testCase of suite.cases) {
    const inference = makeInference();
    if (inference instanceof ScriptedModelInference && suite.scriptedTurns !== undefined) {
      inference.enqueue(...suite.scriptedTurns(testCase));
    }
    try {
      scores.push(await suite.runCase(testCase, { inference }));
    } catch (error) {
      // Only the case id and error class are kept: messages may quote case text.
      errors.push({ id: testCase.id, message: error instanceof Error ? error.name : 'error' });
    }
  }
  return aggregate(suite, scores, errors);
}

export function formatReport(reports: readonly SuiteReport[], implementation: string): string {
  const lines = [`inference adapter: ${implementation}`];
  if (implementation === 'scripted-fake') {
    lines.push('(scripted fake: scores check the harness, not a model)');
  }
  for (const report of reports) {
    lines.push('', `${report.suite}: ${report.cases} cases. ${report.description}`);
    for (const [metric, { mean, applied }] of Object.entries(report.metrics)) {
      lines.push(`  ${metric.padEnd(34)} ${(mean * 100).toFixed(1).padStart(5)}%  (${applied})`);
    }
    for (const error of report.errors) lines.push(`  ERROR ${error.id}: ${error.message}`);
  }
  return lines.join('\n');
}
