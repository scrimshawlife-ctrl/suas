/**
 * Amazon Bedrock adapter for the model inference port, over the Converse API.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.2 (Bedrock), §4.1, §7 (model not
 * chosen; model access must be enabled in the AWS console).
 *
 * The model id is configuration. Constructing the adapter without one is a
 * programming error; `createModelInferencePort` returns the unavailable port
 * instead. This file never logs request or response content: intake text is
 * sensitive, and the logger record carries only the outcome.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { awsErrorName, isAwsTimeout } from '../aws/errors.js';
import type {
  ModelFailureKind,
  ModelInferencePort,
  ModelMessage,
  ModelMessagePart,
  ModelToolCall,
  ModelToolDefinition,
  ModelTurnRequest,
  ModelTurnResult,
} from './model-inference.js';

export const BEDROCK_IMPLEMENTATION = 'bedrock' as const;

/** Implementation-owned bound, not a released SLO. */
export const BEDROCK_TIMEOUT_MS = 30_000;

/** Content-free log record. */
export interface BedrockInferenceLogRecord {
  readonly implementation: typeof BEDROCK_IMPLEMENTATION;
  readonly ok: boolean;
  readonly failure?: ModelFailureKind;
}

export type BedrockInferenceLogger = (record: BedrockInferenceLogRecord) => void;

/** The one Bedrock client method this adapter uses; tests supply a fake. */
export interface BedrockClientLike {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}

export interface BedrockInferenceOptions {
  readonly modelId: string;
  readonly region: string;
  readonly client?: BedrockClientLike;
  readonly timeoutMs?: number;
  readonly logger?: BedrockInferenceLogger;
}

const REFUSED_STOP_REASONS: ReadonlySet<string> = new Set([
  'content_filtered',
  'guardrail_intervened',
]);

export class BedrockModelInference implements ModelInferencePort {
  readonly implementation = BEDROCK_IMPLEMENTATION;

  private readonly modelId: string;
  private readonly client: BedrockClientLike;
  private readonly timeoutMs: number;
  private readonly logger: BedrockInferenceLogger | undefined;

  constructor(options: BedrockInferenceOptions) {
    this.modelId = options.modelId;
    this.client = options.client ?? new BedrockRuntimeClient({ region: options.region });
    this.timeoutMs = options.timeoutMs ?? BEDROCK_TIMEOUT_MS;
    this.logger = options.logger;
  }

  isAvailable(): boolean {
    return true;
  }

  async converse(request: ModelTurnRequest): Promise<ModelTurnResult> {
    let output: ConverseCommandOutput;
    try {
      output = await this.client.send(
        new ConverseCommand({
          modelId: this.modelId,
          system: [{ text: request.system }],
          messages: request.messages.map(toBedrockMessage),
          ...(request.tools.length > 0
            ? { toolConfig: { tools: request.tools.map(toBedrockTool) } }
            : {}),
        }),
        { abortSignal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error: unknown) {
      return this.fail(classifyError(error));
    }
    return this.fromOutput(output);
  }

  private fromOutput(output: ConverseCommandOutput): ModelTurnResult {
    if (output.stopReason !== undefined && REFUSED_STOP_REASONS.has(output.stopReason)) {
      return this.fail('refused');
    }
    // Truncated or malformed output (max_tokens, malformed_tool_use, ...) cannot
    // be trusted as a whole turn, especially half-written tool input.
    const complete =
      output.stopReason === 'end_turn' ||
      output.stopReason === 'tool_use' ||
      output.stopReason === 'stop_sequence';
    if (!complete) return this.fail('invalid');

    let text = '';
    const toolCalls: ModelToolCall[] = [];
    for (const block of output.output?.message?.content ?? []) {
      if (block.text !== undefined) text += block.text;
      if (block.toolUse?.toolUseId !== undefined && block.toolUse.name !== undefined) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: block.toolUse.input ?? {},
        });
      }
    }
    if (text.trim() === '' && toolCalls.length === 0) return this.fail('invalid');

    this.logger?.({ implementation: BEDROCK_IMPLEMENTATION, ok: true });
    return { ok: true, text, toolCalls };
  }

  private fail(failure: ModelFailureKind): ModelTurnResult {
    this.logger?.({ implementation: BEDROCK_IMPLEMENTATION, ok: false, failure });
    return { ok: false, failure };
  }
}

/**
 * Timeouts and a rejected request keep their own kinds. Everything else (no model
 * access, throttling, service errors, network failures) means the capability is
 * unavailable right now, so the caller shows the plain form.
 */
function classifyError(error: unknown): ModelFailureKind {
  if (isAwsTimeout(error)) return 'timeout';
  return awsErrorName(error) === 'ValidationException' ? 'invalid' : 'unavailable';
}

function toBedrockMessage(message: ModelMessage): Message {
  return { role: message.role, content: message.parts.map(toBedrockBlock) };
}

function toBedrockBlock(part: ModelMessagePart): ContentBlock {
  switch (part.type) {
    case 'text':
      return { text: part.text };
    case 'tool_call':
      return {
        toolUse: {
          toolUseId: part.call.id,
          name: part.call.name,
          input: part.call.input as never,
        },
      };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: part.callId,
          content: [{ text: part.content }],
          status: part.isError === true ? 'error' : 'success',
        },
      };
  }
}

function toBedrockTool(tool: ModelToolDefinition): Tool {
  return {
    toolSpec: {
      name: tool.name,
      description: tool.description,
      inputSchema: { json: tool.inputSchema as never },
    },
  };
}
