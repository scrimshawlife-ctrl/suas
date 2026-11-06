import type { SuasConfig } from '../config/index.js';
import { BedrockModelInference } from './bedrock-inference.js';
import { ScriptedModelInference } from './fake-model-inference.js';
import { UnavailableModelInference, type ModelInferencePort } from './model-inference.js';

export {
  BEDROCK_IMPLEMENTATION,
  BEDROCK_TIMEOUT_MS,
  BedrockModelInference,
  type BedrockClientLike,
  type BedrockInferenceLogRecord,
  type BedrockInferenceLogger,
  type BedrockInferenceOptions,
} from './bedrock-inference.js';
export { ScriptedModelInference, type ScriptedTurn } from './fake-model-inference.js';
export {
  MODEL_FAILURE_KINDS,
  UnavailableModelInference,
  type ModelFailureKind,
  type ModelInferencePort,
  type ModelMessage,
  type ModelMessagePart,
  type ModelToolCall,
  type ModelToolDefinition,
  type ModelTurnRequest,
  type ModelTurnResult,
} from './model-inference.js';

/**
 * Inference port for this configuration. `disabled`, and `bedrock` with no model
 * id (the model is not chosen yet), yield the unavailable port so callers show
 * the plain form. Config validation has already refused real AWS in LOCAL/TEST
 * and the fake in PRODUCTION.
 */
export function createModelInferencePort(config: SuasConfig): ModelInferencePort {
  const { mode, bedrockModelId } = config.modelInference;
  if (mode === 'fake') return new ScriptedModelInference();
  if (mode === 'bedrock' && bedrockModelId !== undefined && config.aws.region !== undefined) {
    return new BedrockModelInference({ modelId: bedrockModelId, region: config.aws.region });
  }
  return new UnavailableModelInference();
}
