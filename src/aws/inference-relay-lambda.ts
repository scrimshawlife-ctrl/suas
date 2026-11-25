/**
 * Inference relay function (R17.3, contributor proposal, not released). The STAGING VPC has no
 * route to Bedrock, so this function runs outside it, with no database access, and is the only
 * code that calls Bedrock. The API invokes it with `{ purpose, request, deadlineMs }` and gets
 * back the port's `ModelTurnResult`.
 *
 * It reads `SUAS_ENV` (STAGING only), `SUAS_AWS_REGION`, `SUAS_BEDROCK_MODEL_ID`,
 * `SUAS_BEDROCK_GUARDRAIL_ID` and `SUAS_BEDROCK_GUARDRAIL_VERSION`, and fails closed when any is
 * missing. It does not use `loadConfig`: like the email and VA relays it holds only its own
 * settings. It logs outcomes only, never prompt or response text, and never throws.
 */

import {
  BedrockModelInference,
  type BedrockClientLike,
  type BedrockInferenceLogRecord,
} from '../inference/bedrock-inference.js';
import { inferenceRelayEventSchema, relayRequestOf } from '../inference/inference-relay.js';
import {
  INFERENCE_PURPOSE_LIMITS,
  type ModelFailureKind,
  type ModelTurnResult,
} from '../inference/model-inference.js';

/** Only STAGING deploys this function (R17.1, proposal); PRODUCTION inference stays refused. */
const RELAY_ENVIRONMENT = 'STAGING';

/** Content-free log lines only: the call outcome, or why a call was refused. */
export type InferenceRelayLogRecord =
  | ({ readonly msg: 'model_inference' } & BedrockInferenceLogRecord)
  | {
      readonly msg: 'inference_relay_refused';
      readonly reason: 'environment' | 'not_configured' | 'request';
    };

/** Test seams. Production reads the function's environment and calls Bedrock. */
export interface InferenceRelayDeps {
  readonly environment: string | undefined;
  readonly region: string | undefined;
  readonly modelId: string | undefined;
  readonly guardrailId: string | undefined;
  readonly guardrailVersion: string | undefined;
  readonly log: (record: InferenceRelayLogRecord) => void;
  readonly client?: BedrockClientLike;
}

function defaultDeps(): InferenceRelayDeps {
  return {
    environment: process.env.SUAS_ENV,
    region: process.env.SUAS_AWS_REGION,
    modelId: process.env.SUAS_BEDROCK_MODEL_ID,
    guardrailId: process.env.SUAS_BEDROCK_GUARDRAIL_ID,
    guardrailVersion: process.env.SUAS_BEDROCK_GUARDRAIL_VERSION,
    log: (record) => console.info(JSON.stringify(record)),
  };
}

// Review 2026-11-24 (#365): each setting must have its AWS form, not only be present, so a
// malformed value fails closed before a client is built. Model id matches CFN BedrockModelId.
const SETTING_PATTERNS = {
  region: /^[a-z]{2}(-[a-z]+)+-\d$/,
  modelId: /^[a-z0-9-]+\.[a-z0-9][a-z0-9.:-]*$/,
  guardrailId: /^(arn:aws[a-z-]*:bedrock:[a-z0-9-]+:\d{12}:guardrail\/)?[a-z0-9]{12}$/,
  guardrailVersion: /^([1-9]\d{0,7}|DRAFT)$/,
} as const;

const wellFormed = (key: keyof typeof SETTING_PATTERNS, value: string | undefined): boolean =>
  value !== undefined && SETTING_PATTERNS[key].test(value);

/** Builds a handler with its own per-container Bedrock adapter. */
export function createInferenceRelayHandler(
  deps: InferenceRelayDeps = defaultDeps(),
): (event: unknown) => Promise<ModelTurnResult> {
  let adapter: BedrockModelInference | undefined;

  const refuse = (
    reason: 'environment' | 'not_configured' | 'request',
    failure: ModelFailureKind,
  ): ModelTurnResult => {
    deps.log({ msg: 'inference_relay_refused', reason });
    return { ok: false, failure };
  };

  const loadAdapter = (): BedrockModelInference | undefined => {
    if (adapter !== undefined) return adapter;
    const { region, modelId, guardrailId, guardrailVersion } = deps;
    if (
      region === undefined ||
      modelId === undefined ||
      guardrailId === undefined ||
      guardrailVersion === undefined ||
      !wellFormed('region', region) ||
      !wellFormed('modelId', modelId) ||
      !wellFormed('guardrailId', guardrailId) ||
      !wellFormed('guardrailVersion', guardrailVersion)
    ) {
      return undefined;
    }
    adapter = new BedrockModelInference({
      modelId,
      region,
      guardrail: { identifier: guardrailId, version: guardrailVersion },
      logger: (record) => deps.log({ msg: 'model_inference', ...record }),
      ...(deps.client !== undefined ? { client: deps.client } : {}),
    });
    return adapter;
  };

  return async (event) => {
    if (deps.environment !== RELAY_ENVIRONMENT) return refuse('environment', 'unavailable');
    const current = loadAdapter();
    if (current === undefined) return refuse('not_configured', 'unavailable');
    // A malformed turn cannot become answerable by retrying it.
    const parsed = inferenceRelayEventSchema.safeParse(event);
    if (!parsed.success) return refuse('request', 'invalid');

    // The event's purpose and deadline win, and the output cap never exceeds the purpose's.
    const { purpose, deadlineMs } = parsed.data;
    const request = relayRequestOf(parsed.data);
    const limit = INFERENCE_PURPOSE_LIMITS[purpose].maxTokens;
    try {
      return await current.converse({
        ...request,
        purpose,
        deadlineMs,
        maxTokens: Math.min(request.maxTokens ?? limit, limit),
      });
    } catch {
      // The adapter does not throw; if it did, drop the error, which could quote the request.
      return { ok: false, failure: 'unavailable' };
    }
  };
}

export const handler = createInferenceRelayHandler();
