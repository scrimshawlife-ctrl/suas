/**
 * Wire contract of the outside-VPC inference relay function (R17.3, contributor proposal, not
 * released). The API sends one model turn with its purpose and remaining deadline; the relay
 * answers with the port's own `ModelTurnResult`. Both sides parse with these schemas.
 */

import { z } from 'zod';
import {
  INFERENCE_PURPOSES,
  MODEL_FAILURE_KINDS,
  type InferencePurpose,
  type ModelTurnRequest,
} from './model-inference.js';

const toolCallSchema = z
  .object({ id: z.string().min(1), name: z.string().min(1), input: z.unknown() })
  .strict();

const partSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('text'), text: z.string(), guarded: z.literal(true).optional() })
    .strict(),
  z.object({ type: z.literal('tool_call'), call: toolCallSchema }).strict(),
  z
    .object({
      type: z.literal('tool_result'),
      callId: z.string().min(1),
      content: z.string(),
      isError: z.boolean().optional(),
    })
    .strict(),
]);

const requestSchema = z
  .object({
    system: z.string(),
    messages: z
      .array(
        z
          .object({ role: z.enum(['user', 'assistant']), parts: z.array(partSchema).min(1) })
          .strict(),
      )
      .min(1),
    tools: z.array(
      z
        .object({
          name: z.string().min(1),
          description: z.string(),
          inputSchema: z.record(z.string(), z.unknown()),
        })
        .strict(),
    ),
    purpose: z.enum(INFERENCE_PURPOSES).optional(),
    deadlineMs: z.number().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();

export const inferenceRelayEventSchema = z
  .object({
    purpose: z.enum(INFERENCE_PURPOSES),
    request: requestSchema,
    deadlineMs: z.number().int().positive(),
  })
  .strict();

/** R17.x (contributor's call, D-064): a count no real turn reaches is refused, not summed. */
const tokenCount = z.number().int().nonnegative().max(1_000_000);

export const inferenceRelayResultSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      text: z.string(),
      toolCalls: z.array(toolCallSchema),
      usage: z
        .object({ inputTokens: tokenCount, outputTokens: tokenCount })
        .strict()
        .exactOptional(),
    })
    .strict(),
  z.object({ ok: z.literal(false), failure: z.enum(MODEL_FAILURE_KINDS) }).strict(),
]);

/** The relay function's input: `deadlineMs` is what the caller still allows, in milliseconds. */
export interface InferenceRelayEvent {
  readonly purpose: InferencePurpose;
  readonly request: ModelTurnRequest;
  readonly deadlineMs: number;
}

/** A parsed event's request; the schema matches the port type but for `| undefined` optionals. */
export function relayRequestOf(
  event: z.output<typeof inferenceRelayEventSchema>,
): ModelTurnRequest {
  return event.request as ModelTurnRequest;
}
