/**
 * The model inference port inside the STAGING VPC (R17.3, contributor proposal, not released).
 * The VPC has no route to Bedrock, so each turn goes by Lambda Invoke to the outside-VPC
 * inference relay, which alone calls Bedrock. Same pattern as the email and VA relays.
 *
 * Every failed invoke is a typed failure, never a throw: a throttle, a function error or a
 * Lambda 5xx is `unavailable`, an abort is `timeout`, a malformed answer is `invalid`. A model
 * turn changes no state, so there is no ambiguous outcome. SDK retries are off: the caller
 * falls back to the plain form. Nothing here logs request or response content.
 */

import { InvokeCommand, LambdaClient, type InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { isAwsTimeout } from '../aws/errors.js';
import { inferenceRelayResultSchema, type InferenceRelayEvent } from './inference-relay.js';
import type {
  ModelFailureKind,
  ModelInferenceLogger,
  ModelInferencePort,
  ModelTurnRequest,
  ModelTurnResult,
} from './model-inference.js';

export const BEDROCK_RELAY_IMPLEMENTATION = 'bedrock-relay' as const;

/** Deadline sent when the caller names none: the extraction call cap plus its margin. */
export const DEFAULT_RELAY_DEADLINE_MS = 25_000;

/** Above the relay function's own 27 s timeout, so the relay answers first. */
export const INFERENCE_RELAY_INVOKE_TIMEOUT_MS = 28_000;

/** The one Lambda client method this port uses; tests supply a fake. */
export interface LambdaClientLike {
  send(
    command: InvokeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeCommandOutput>;
}

export interface LambdaRelayInferenceOptions {
  readonly functionName: string;
  readonly region: string;
  readonly client?: LambdaClientLike;
  readonly logger?: ModelInferenceLogger;
}

export class LambdaRelayModelInference implements ModelInferencePort {
  readonly implementation = BEDROCK_RELAY_IMPLEMENTATION;

  private readonly client: LambdaClientLike;

  constructor(private readonly options: LambdaRelayInferenceOptions) {
    this.client = options.client ?? new LambdaClient({ region: options.region, maxAttempts: 1 });
  }

  isAvailable(): boolean {
    return true;
  }

  async converse(request: ModelTurnRequest): Promise<ModelTurnResult> {
    const deadlineMs = Math.floor(request.deadlineMs ?? DEFAULT_RELAY_DEADLINE_MS);
    if (deadlineMs <= 0) return this.finish({ ok: false, failure: 'timeout' });
    // An unnamed purpose gets the tighter intake bounds.
    const event: InferenceRelayEvent = {
      purpose: request.purpose ?? 'intake',
      request,
      deadlineMs,
    };

    let output: InvokeCommandOutput;
    try {
      output = await this.client.send(
        new InvokeCommand({
          FunctionName: this.options.functionName,
          InvocationType: 'RequestResponse',
          Payload: new TextEncoder().encode(JSON.stringify(event)),
        }),
        {
          abortSignal: AbortSignal.timeout(Math.min(deadlineMs, INFERENCE_RELAY_INVOKE_TIMEOUT_MS)),
        },
      );
    } catch (error: unknown) {
      return this.finish({ ok: false, failure: invokeFailure(error) });
    }

    // The relay never throws for a model outcome: a function error is a crash or its timeout.
    if (output.FunctionError !== undefined) {
      return this.finish({ ok: false, failure: 'unavailable' });
    }
    const parsed = inferenceRelayResultSchema.safeParse(parsePayload(output.Payload));
    return this.finish(parsed.success ? parsed.data : { ok: false, failure: 'invalid' });
  }

  private finish(result: ModelTurnResult): ModelTurnResult {
    this.options.logger?.({
      implementation: BEDROCK_RELAY_IMPLEMENTATION,
      ok: result.ok,
      ...(result.ok ? {} : { failure: result.failure }),
    });
    return result;
  }
}

/**
 * An abort or timeout is `timeout`. Everything else that stops the invoke (a Lambda throttle,
 * a 5xx, a missing grant or function, a lost connection) means the capability is unavailable.
 */
export function invokeFailure(error: unknown): ModelFailureKind {
  return isAwsTimeout(error) ? 'timeout' : 'unavailable';
}

function parsePayload(payload: Uint8Array | undefined): unknown {
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
}
