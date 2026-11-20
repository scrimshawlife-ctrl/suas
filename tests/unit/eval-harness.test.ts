/**
 * Eval harness run metrics: nearest-rank latency percentiles, model call and token sums, and
 * `<think` reasoning leaks, measured over a scripted port with a fake clock. No model is called.
 */

import { describe, expect, it } from 'vitest';
import { formatReport, nearestRank, runSuite, type EvalSuite } from '../../eval/harness.js';
import { ScriptedModelInference, type ScriptedTurn } from '../../src/inference/index.js';

interface TimedCase {
  readonly id: string;
  /** Fake milliseconds each model call takes. */
  readonly delayMs: number;
  readonly calls: number;
  readonly text: string;
}

const CASES: readonly TimedCase[] = [
  { id: 'a', delayMs: 40, calls: 1, text: 'fine' },
  { id: 'b', delayMs: 10, calls: 1, text: 'fine' },
  { id: 'c', delayMs: 100, calls: 1, text: '<THINK>plan</think> fine' },
  { id: 'd', delayMs: 15, calls: 2, text: 'fine' },
  { id: 'e', delayMs: 20, calls: 1, text: 'fine' },
];

describe('runSuite run metrics', () => {
  it('reports latency percentiles, call and token sums, and reasoning leaks', async () => {
    let clock = 0;
    const suite: EvalSuite<TimedCase> = {
      name: 'timed',
      description: 'scripted delays and usage',
      cases: CASES,
      scriptedTurns: (testCase) =>
        Array.from({ length: testCase.calls }, (): ScriptedTurn => () => {
          clock += testCase.delayMs;
          return {
            ok: true,
            text: testCase.text,
            toolCalls: [],
            usage: { inputTokens: 100, outputTokens: 7 },
          };
        }),
      async runCase(testCase, { inference }) {
        for (let i = 0; i < testCase.calls; i += 1) {
          await inference.converse({ system: '', messages: [], tools: [] });
        }
        return { id: testCase.id, metrics: { done: 1 } };
      },
    };

    const report = await runSuite(
      suite,
      () => new ScriptedModelInference(),
      () => clock,
    );

    // Per-case latencies 40, 10, 100, 30, 20: rank ceil(2.5)=3 -> 30, rank ceil(4.75)=5 -> 100.
    expect(report.latency_ms_p50).toBe(30);
    expect(report.latency_ms_p95).toBe(100);
    expect(report.model_calls).toBe(6);
    expect(report.input_tokens).toBe(600);
    expect(report.output_tokens).toBe(42);
    expect(report.reasoning_leak_count).toBe(1);
    expect(report.metrics).toEqual({ done: { mean: 1, applied: 5 } });
  });

  it('counts failed calls but no tokens or leaks for them', async () => {
    const suite: EvalSuite<{ id: string }> = {
      name: 'failing',
      description: 'an unavailable model',
      cases: [{ id: 'x' }],
      async runCase(testCase, { inference }) {
        await inference.converse({ system: '', messages: [], tools: [] });
        return { id: testCase.id, metrics: {} };
      },
    };
    const report = await runSuite(
      suite,
      () => new ScriptedModelInference(),
      () => 0,
    );
    expect(report).toMatchObject({
      model_calls: 1,
      input_tokens: 0,
      output_tokens: 0,
      reasoning_leak_count: 0,
      latency_ms_p50: 0,
      latency_ms_p95: 0,
    });
  });
});

// R18.6 (contributor's call, D-066): a report names the cases that scored 0, per metric.
describe('runSuite failure ids', () => {
  it('lists the cases that scored 0 for each metric, in the report and its text', async () => {
    const suite: EvalSuite<{ id: string; ok: boolean }> = {
      name: 'mixed',
      description: 'one failing case',
      cases: [
        { id: 'pass', ok: true },
        { id: 'fail', ok: false },
      ],
      runCase: (testCase) =>
        Promise.resolve({
          id: testCase.id,
          metrics: { right: testCase.ok ? 1 : 0, skipped: null, always: 1 },
        }),
    };
    const report = await runSuite(
      suite,
      () => new ScriptedModelInference(),
      () => 0,
    );
    expect(report.failures).toEqual({ right: ['fail'] });
    expect(formatReport([report], 'scripted-fake')).toContain('  FAIL right: fail');
  });
});

describe('nearestRank', () => {
  it('is 0 for no values and the single value for one', () => {
    expect(nearestRank([], 95)).toBe(0);
    expect(nearestRank([12], 50)).toBe(12);
  });
});
