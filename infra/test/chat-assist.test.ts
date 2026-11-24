/**
 * Helper-side chat assistance (R18.7, contributor proposal, not released): `-c chatAssist=true`
 * sets SUAS_CHAT_ASSIST_MODE=enabled on the API only, and only beside modelInference=bedrock.
 */

import { describe, expect, it } from 'vitest';
import { tryLoadConfig } from '../../src/config/index.js';
import { resolveForValidation, synthesize, type Synthesized } from './helpers.js';

type Resource = { Type: string; Properties?: Record<string, any> };
const variablesOf = (t: Synthesized['backend'], handler: string): Record<string, unknown> => {
  const resources = Object.values(t.toJSON().Resources as Record<string, Resource>);
  const fn = resources.find(
    (r) => r.Type === 'AWS::Lambda::Function' && r.Properties?.Handler === handler,
  );
  return fn?.Properties?.Environment.Variables;
};

const BEDROCK = { modelInference: 'bedrock', bedrockModelId: 'qwen.qwen3-32b-v1:0' };

describe('chat assist', () => {
  it('adds no SUAS_CHAT_ASSIST_MODE by default or with bedrock alone', () => {
    for (const context of [{}, BEDROCK]) {
      expect(variablesOf(synthesize(context).backend, 'run.sh')).not.toHaveProperty(
        'SUAS_CHAT_ASSIST_MODE',
      );
    }
  });

  it('enables it on the API, not the job worker, with modelInference=bedrock', () => {
    const { backend } = synthesize({ ...BEDROCK, chatAssist: 'true' });
    expect(variablesOf(backend, 'run.sh')).toMatchObject({
      SUAS_CHAT_ASSIST_MODE: 'enabled',
      SUAS_MODEL_INFERENCE_MODE: 'bedrock',
    });
    expect(variablesOf(backend, 'job-worker.handler')).not.toHaveProperty('SUAS_CHAT_ASSIST_MODE');
    // The API's real startup check accepts the synthesized environment.
    const json = backend.toJSON();
    const resources = { ...json.Resources, ...(json.Parameters ?? {}) };
    const env = Object.fromEntries(
      Object.entries(variablesOf(backend, 'run.sh')).map(([k, v]) => [
        k,
        resolveForValidation(v, resources),
      ]),
    );
    const result = tryLoadConfig(env);
    expect(result.ok ? [] : result.issues).toEqual([]);
    if (result.ok) expect(result.config.chatAssist.mode).toBe('enabled');
  });

  it('refuses chatAssist=true without modelInference=bedrock, and values other than true/false', () => {
    expect(() => synthesize({ chatAssist: 'true' })).toThrow(
      /chatAssist=true.*modelInference=bedrock/,
    );
    expect(() => synthesize({ ...BEDROCK, chatAssist: 'yes' })).toThrow(/true or false/);
  });
});
