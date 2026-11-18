/** The load harness verdict: a run with any failed sample is never reported as within target. */
import { describe, expect, it } from 'vitest';
import { summarizeLoad } from '../../scripts/synthetic-load-harness.js';

const FAST_SAMPLES = [5, 6, 7, 8, 9];
const TARGET_MS = 1000;

describe('summarizeLoad', () => {
  it('reports an all-success run under the target as within target', () => {
    const summary = summarizeLoad(FAST_SAMPLES, 0, TARGET_MS);
    expect(summary.failures).toBe(0);
    expect(summary.p95_ms).toBe(9);
    expect(summary.observed_p95_within_target).toBe(true);
  });

  it('never reports a run with a failed sample as within target', () => {
    const summary = summarizeLoad(FAST_SAMPLES, 1, TARGET_MS);
    expect(summary.failures).toBe(1);
    expect(summary.observed_p95_within_target).toBe(false);
  });

  it('reports a run with no samples as not within target', () => {
    expect(summarizeLoad([], 0, TARGET_MS).observed_p95_within_target).toBe(false);
  });
});
