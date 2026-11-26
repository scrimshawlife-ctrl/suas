/**
 * Model inference capability port: one tool-calling conversation turn.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 (Intake Assistant has exactly two
 * model tools and a plain-form fallback), §2.2 (Amazon Bedrock), §4.1.
 * AGENTS.md rule 6 (provider SDKs and payloads stay in adapters), rule 14 (no
 * safety-critical generative behavior; callers keep a human confirmation step).
 *
 * The port knows nothing about Bedrock, intake, or any specific tool. A caller
 * sends the system text, the prior turns and the tool definitions, and gets back
 * assistant text and/or tool calls, or a typed failure. Callers must show the
 * plain form when the result is a failure or the port is unavailable.
 *
 * Message content is sensitive intake text. Neither the port nor any adapter
 * may write it to logs.
 */

export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  /** JSON Schema object describing the tool's input. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelToolCall {
  /** Identifier the caller echoes back in the matching tool result. */
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export type ModelMessagePart =
  | {
      readonly type: 'text';
      readonly text: string;
      /**
       * Untrusted Veteran text the provider's safety filter must screen (R17.5, contributor
       * proposal, not released). Adapters without such a filter send it as plain text.
       */
      readonly guarded?: true;
    }
  | { readonly type: 'tool_call'; readonly call: ModelToolCall }
  | {
      readonly type: 'tool_result';
      readonly callId: string;
      readonly content: string;
      readonly isError?: boolean;
    };

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly parts: readonly ModelMessagePart[];
}

/** What a turn is for; it picks the per-call bounds below. */
export const INFERENCE_PURPOSES = ['intake', 'extraction'] as const;
export type InferencePurpose = (typeof INFERENCE_PURPOSES)[number];

/**
 * Per-purpose output cap and per-call timeout cap (R17.3, contributor proposal, not released).
 * Implementation bounds that keep a turn inside the 29 s HTTP API limit; not released SLOs.
 */
export const INFERENCE_PURPOSE_LIMITS: Readonly<
  Record<InferencePurpose, { readonly maxTokens: number; readonly callTimeoutCapMs: number }>
> = {
  intake: { maxTokens: 800, callTimeoutCapMs: 12_000 },
  extraction: { maxTokens: 2_048, callTimeoutCapMs: 24_000 },
};

export interface ModelTurnRequest {
  readonly system: string;
  /** Prior turns in order. Must end with a `user` message. */
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
  /** Selects the per-purpose bounds; a relay forwards it. */
  readonly purpose?: InferencePurpose;
  /** Milliseconds the caller still allows for this call; the adapter stops before it. */
  readonly deadlineMs?: number;
  /** Output token cap for this call. */
  readonly maxTokens?: number;
}

/**
 * - `unavailable`: no model configured, no access, throttled, or the service is down.
 * - `timeout`: no answer within the adapter's bound.
 * - `refused`: the model or a safety filter declined to answer.
 * - `invalid`: the request was rejected or the output was truncated or malformed.
 */
export const MODEL_FAILURE_KINDS = ['unavailable', 'timeout', 'refused', 'invalid'] as const;
export type ModelFailureKind = (typeof MODEL_FAILURE_KINDS)[number];

export type ModelTurnResult =
  | {
      readonly ok: true;
      /** Empty when the turn is tool calls only. */
      readonly text: string;
      /** Empty when the turn is text only. At least one of text and toolCalls is non-empty. */
      readonly toolCalls: readonly ModelToolCall[];
      /** Provider token counts, when the adapter reports them; the eval harness sums them. */
      readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
    }
  | { readonly ok: false; readonly failure: ModelFailureKind };

/** Content-free log record of one model call (C-14): the outcome only, never text. */
export interface ModelInferenceLogRecord {
  readonly implementation: string;
  readonly ok: boolean;
  readonly failure?: ModelFailureKind;
}

export type ModelInferenceLogger = (record: ModelInferenceLogRecord) => void;

export interface ModelInferencePort {
  readonly implementation: string;
  /** False when the capability is not configured; callers show the plain form. */
  isAvailable(): boolean;
  /** Never throws for provider failures; they come back as `{ ok: false }`. */
  converse(request: ModelTurnRequest): Promise<ModelTurnResult>;
}

/** Port used when inference is disabled or the model is not chosen. */
export class UnavailableModelInference implements ModelInferencePort {
  readonly implementation = 'unavailable';

  isAvailable(): boolean {
    return false;
  }

  converse(): Promise<ModelTurnResult> {
    return Promise.resolve({ ok: false, failure: 'unavailable' });
  }
}
