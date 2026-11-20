import type { SuasConfig } from '../config/index.js';
import { BedrockModelInference } from './bedrock-inference.js';
import { ScriptedModelInference } from './fake-model-inference.js';
import {
  UnavailableModelInference,
  type ModelInferenceLogger,
  type ModelInferencePort,
} from './model-inference.js';

export {
  BEDROCK_IMPLEMENTATION,
  BEDROCK_TIMEOUT_MS,
  BedrockModelInference,
  DEADLINE_MARGIN_MS,
  DEFAULT_MAX_TOKENS,
  type BedrockClientLike,
  type BedrockGuardrail,
  type BedrockInferenceLogRecord,
  type BedrockInferenceLogger,
  type BedrockInferenceOptions,
} from './bedrock-inference.js';
export { ScriptedModelInference, type ScriptedTurn } from './fake-model-inference.js';
export {
  INFERENCE_PURPOSE_LIMITS,
  INFERENCE_PURPOSES,
  MODEL_FAILURE_KINDS,
  UnavailableModelInference,
  type InferencePurpose,
  type ModelFailureKind,
  type ModelInferenceLogger,
  type ModelInferenceLogRecord,
  type ModelInferencePort,
  type ModelMessage,
  type ModelMessagePart,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelTurnRequest,
  type ModelTurnResult,
} from './model-inference.js';

/** One JSON line per model call with the outcome only (C-14); never request or response text. */
export const consoleInferenceLogger: ModelInferenceLogger = (record) => {
  console.info(JSON.stringify({ level: 'info', msg: 'model_inference', ...record }));
};

/**
 * Inference port for this configuration. `disabled`, and `bedrock` with no model
 * id (the model is not chosen yet), yield the unavailable port so callers show
 * the plain form. Config validation has already refused real AWS in LOCAL/TEST
 * and any model inference in STAGING/PRODUCTION (SAFETY.md §6).
 */
export function createModelInferencePort(
  config: SuasConfig,
  logger: ModelInferenceLogger = consoleInferenceLogger,
): ModelInferencePort {
  const { mode, bedrockModelId } = config.modelInference;
  if (mode === 'fake') return new ScriptedModelInference();
  if (mode === 'bedrock' && bedrockModelId !== undefined && config.aws.region !== undefined) {
    return new BedrockModelInference({
      modelId: bedrockModelId,
      region: config.aws.region,
      logger,
    });
  }
  return new UnavailableModelInference();
}
