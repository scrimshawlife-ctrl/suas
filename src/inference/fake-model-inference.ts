/**
 * Deterministic fake for the model inference port (LOCAL/TEST; AGENTS.md rule 7).
 *
 * A test queues results with `enqueue`. Each `converse` call consumes the next
 * one, or computes it from the request when a function was queued. An empty
 * queue answers `unavailable`, so unscripted code paths take the plain-form
 * fallback instead of inventing model output. It never reaches a network.
 */

import type { ModelInferencePort, ModelTurnRequest, ModelTurnResult } from './model-inference.js';

export type ScriptedTurn = ModelTurnResult | ((request: ModelTurnRequest) => ModelTurnResult);

export class ScriptedModelInference implements ModelInferencePort {
  readonly implementation = 'scripted-fake';

  private readonly script: ScriptedTurn[] = [];
  private readonly received: ModelTurnRequest[] = [];

  isAvailable(): boolean {
    return true;
  }

  /** Queue the results for the next calls, in order. */
  enqueue(...turns: ScriptedTurn[]): this {
    this.script.push(...turns);
    return this;
  }

  converse(request: ModelTurnRequest): Promise<ModelTurnResult> {
    this.received.push(request);
    const next = this.script.shift();
    if (next === undefined) return Promise.resolve({ ok: false, failure: 'unavailable' });
    return Promise.resolve(typeof next === 'function' ? next(request) : next);
  }

  /** Test-only inspection of every request received. */
  requests(): readonly ModelTurnRequest[] {
    return this.received;
  }
}
