import type { SuasConfig } from '../config/index.js';
import { BedrockModelInference } from './bedrock-inference.js';
import { ScriptedModelInference } from './fake-model-inference.js';
import { LambdaRelayModelInference } from './lambda-relay-inference.js';
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
  inferenceRelayEventSchema,
  inferenceRelayResultSchema,
  type InferenceRelayEvent,
} from './inference-relay.js';
export {
  BEDROCK_RELAY_IMPLEMENTATION,
  DEFAULT_RELAY_DEADLINE_MS,
  INFERENCE_RELAY_INVOKE_TIMEOUT_MS,
  LambdaRelayModelInference,
  type LambdaRelayInferenceOptions,
} from './lambda-relay-inference.js';
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
 * Inference port for this configuration. `disabled`, and `bedrock` with no model id, yield the
 * unavailable port so callers show the plain form. `bedrock` with a relay function goes through
 * the outside-VPC relay (STAGING, R17.3 contributor proposal, not released); `bedrock` without
 * one calls Bedrock directly, as the relay and the eval do. Config validation has already
 * refused bedrock in LOCAL/TEST and every non-disabled mode in PRODUCTION.
 */
export function createModelInferencePort(
  config: SuasConfig,
  logger: ModelInferenceLogger = consoleInferenceLogger,
): ModelInferencePort {
  const { mode, bedrockModelId, relayFunction, guardrailId, guardrailVersion } =
    config.modelInference;
  const region = config.aws.region;
  if (mode === 'fake') return new ScriptedModelInference();
  if (mode === 'bedrock' && bedrockModelId !== undefined && region !== undefined) {
    if (relayFunction !== undefined) {
      return new LambdaRelayModelInference({ functionName: relayFunction, region, logger });
    }
    return new BedrockModelInference({
      modelId: bedrockModelId,
      region,
      logger,
      ...(guardrailId !== undefined && guardrailVersion !== undefined
        ? { guardrail: { identifier: guardrailId, version: guardrailVersion } }
        : {}),
    });
  }
  return new UnavailableModelInference();
}
