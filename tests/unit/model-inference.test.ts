/**
 * Model inference port: Bedrock Converse mapping, fake, and config selection
 * (V1_PROJECT_PLAN.md §2.2, §4.1). No test reaches AWS.
 */

import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  BedrockModelInference,
  consoleInferenceLogger,
  createModelInferencePort,
  LambdaRelayModelInference,
  ScriptedModelInference,
  UnavailableModelInference,
  type BedrockInferenceLogRecord,
  type ModelTurnRequest,
} from '../../src/inference/index.js';
import { awsError, ScriptedAwsClient } from '../helpers/aws-fake-client.js';
import { validEnv } from '../helpers/env.js';

const SENSITIVE = 'I need a ride to the clinic, my address is 12 Example Lane';

const REQUEST: ModelTurnRequest = {
  system: 'You help fill in a request form.',
  messages: [
    { role: 'user', parts: [{ type: 'text', text: SENSITIVE }] },
    {
      role: 'assistant',
      parts: [
        { type: 'tool_call', call: { id: 't1', name: 'search_resources', input: { q: 'ride' } } },
      ],
    },
    {
      role: 'user',
      parts: [{ type: 'tool_result', callId: 't1', content: '[]', isError: false }],
    },
  ],
  tools: [
    {
      name: 'search_resources',
      description: 'Search resources',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    },
  ],
};

function output(partial: Partial<ConverseCommandOutput>): ConverseCommandOutput {
  return { $metadata: {}, ...partial } as ConverseCommandOutput;
}

function adapterWith(
  responses: Array<ConverseCommandOutput | Error>,
  logs: BedrockInferenceLogRecord[] = [],
  guardrail?: { identifier: string; version: string },
) {
  const client = new ScriptedAwsClient<ConverseCommandOutput>(responses);
  const port = new BedrockModelInference({
    modelId: 'test-model-id',
    region: 'us-west-2',
    client: client,
    logger: (record) => logs.push(record),
    ...(guardrail !== undefined ? { guardrail } : {}),
  });
  return { client, port, logs };
}

const ENDED = output({
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
});

/** A first user turn whose Veteran text is marked for the guardrail. */
const GUARDED: ModelTurnRequest = {
  ...REQUEST,
  messages: [{ role: 'user', parts: [{ type: 'text', text: SENSITIVE, guarded: true }] }],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BedrockModelInference', () => {
  it('sends system, messages and tools in Converse shape', async () => {
    const { client, port } = adapterWith([
      output({
        stopReason: 'end_turn',
        output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      }),
    ]);
    await port.converse(REQUEST);

    expect(client.commands[0]?.input).toEqual({
      modelId: 'test-model-id',
      system: [{ text: REQUEST.system }],
      inferenceConfig: { maxTokens: 800 },
      messages: [
        { role: 'user', content: [{ text: SENSITIVE }] },
        {
          role: 'assistant',
          content: [
            { toolUse: { toolUseId: 't1', name: 'search_resources', input: { q: 'ride' } } },
          ],
        },
        {
          role: 'user',
          content: [
            { toolResult: { toolUseId: 't1', content: [{ text: '[]' }], status: 'success' } },
          ],
        },
      ],
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'search_resources',
              description: 'Search resources',
              inputSchema: { json: REQUEST.tools[0]?.inputSchema },
            },
          },
        ],
      },
    });
    expect(client.commands[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  // R17.2/R17.5 (contributor proposal, not released): explicit output cap, guardrail with
  // trace off, and the Veteran's text in a guardContent block.
  it('sends maxTokens, the guardrail with trace disabled, and guarded text as guardContent', async () => {
    const { client, port } = adapterWith([ENDED], [], { identifier: 'gr-test', version: '3' });
    await port.converse({ ...GUARDED, maxTokens: 2048 });
    expect(client.commands[0]?.input).toMatchObject({
      inferenceConfig: { maxTokens: 2048 },
      guardrailConfig: { guardrailIdentifier: 'gr-test', guardrailVersion: '3', trace: 'disabled' },
      messages: [{ role: 'user', content: [{ guardContent: { text: { text: SENSITIVE } } }] }],
    });
  });

  it('sends guarded text as plain text and no guardrailConfig when no guardrail is set', async () => {
    const { client, port } = adapterWith([ENDED]);
    await port.converse(GUARDED);
    const input = client.commands[0]?.input as Record<string, unknown>;
    expect(input.guardrailConfig).toBeUndefined();
    expect(input.messages).toEqual([{ role: 'user', content: [{ text: SENSITIVE }] }]);
  });

  it.each([
    ['intake with time to spare', { purpose: 'intake', deadlineMs: 24_000 }, 12_000],
    ['intake near its deadline', { purpose: 'intake', deadlineMs: 6_000 }, 5_000],
    ['extraction', { purpose: 'extraction', deadlineMs: 25_000 }, 24_000],
    ['no purpose or deadline', {}, 30_000],
  ] as const)('bounds the call for %s', async (_name, bounds, expected) => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const { port } = adapterWith([ENDED]);
    await port.converse({ ...REQUEST, ...bounds });
    expect(timeout).toHaveBeenCalledWith(expected);
  });

  it('answers timeout without calling Bedrock when the deadline leaves no time', async () => {
    const { client, port } = adapterWith([ENDED]);
    expect(await port.converse({ ...REQUEST, deadlineMs: 900 })).toEqual({
      ok: false,
      failure: 'timeout',
    });
    expect(client.commands).toHaveLength(0);
  });

  it('maps text and tool calls from the assistant message', async () => {
    const { port } = adapterWith([
      output({
        stopReason: 'tool_use',
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Looking that up. ' },
              {
                toolUse: {
                  toolUseId: 't2',
                  name: 'draft_service_request',
                  input: { category: 'FOOD' },
                },
              },
            ],
          },
        },
      }),
    ]);
    expect(await port.converse(REQUEST)).toEqual({
      ok: true,
      text: 'Looking that up. ',
      toolCalls: [{ id: 't2', name: 'draft_service_request', input: { category: 'FOOD' } }],
    });
  });

  it.each([
    ['content_filtered', 'refused'],
    ['guardrail_intervened', 'refused'],
    ['max_tokens', 'invalid'],
    ['malformed_tool_use', 'invalid'],
    ['model_context_window_exceeded', 'invalid'],
  ] as const)('maps stop reason %s to %s', async (stopReason, failure) => {
    const { port } = adapterWith([
      output({
        stopReason,
        output: { message: { role: 'assistant', content: [{ text: 'partial' }] } },
      }),
    ]);
    expect(await port.converse(REQUEST)).toEqual({ ok: false, failure });
  });

  it('treats an empty completed turn as invalid', async () => {
    const { port } = adapterWith([
      output({ stopReason: 'end_turn', output: { message: { role: 'assistant', content: [] } } }),
    ]);
    expect(await port.converse(REQUEST)).toEqual({ ok: false, failure: 'invalid' });
  });

  it.each([
    ['ThrottlingException', 'unavailable'],
    ['AccessDeniedException', 'unavailable'],
    ['ServiceUnavailableException', 'unavailable'],
    ['ModelTimeoutException', 'timeout'],
    ['AbortError', 'timeout'],
    ['TimeoutError', 'timeout'],
    ['ValidationException', 'invalid'],
  ] as const)('maps SDK error %s to %s without throwing', async (name, failure) => {
    const { port } = adapterWith([awsError(name)]);
    expect(await port.converse(REQUEST)).toEqual({ ok: false, failure });
  });

  it('never logs message content', async () => {
    const { port, logs } = adapterWith([
      output({
        stopReason: 'end_turn',
        output: { message: { role: 'assistant', content: [{ text: `echo ${SENSITIVE}` }] } },
      }),
      awsError('ThrottlingException'),
    ]);
    await port.converse(REQUEST);
    await port.converse(REQUEST);
    expect(logs).toEqual([
      { implementation: 'bedrock', ok: true },
      { implementation: 'bedrock', ok: false, failure: 'unavailable' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('clinic');
  });
});

describe('ScriptedModelInference', () => {
  it('answers from the queue in order and records requests', async () => {
    const fake = new ScriptedModelInference().enqueue(
      { ok: true, text: 'one', toolCalls: [] },
      (request) => ({ ok: true, text: `saw ${request.messages.length}`, toolCalls: [] }),
    );
    expect(await fake.converse(REQUEST)).toMatchObject({ text: 'one' });
    expect(await fake.converse(REQUEST)).toMatchObject({ text: 'saw 3' });
    expect(fake.requests()).toHaveLength(2);
  });

  it('answers unavailable when nothing is scripted', async () => {
    expect(await new ScriptedModelInference().converse(REQUEST)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
  });
});

describe('createModelInferencePort', () => {
  // The direct adapter has no valid deployed config (STAGING requires the relay), so it is
  // exercised on a config built past that guard, as the relay and the eval build it.
  const bedrock = (bedrockModelId: string | undefined) => ({
    ...loadConfig(validEnv()),
    aws: { region: 'us-west-2' },
    modelInference: {
      mode: 'bedrock' as const,
      bedrockModelId,
      relayFunction: undefined,
      guardrailId: undefined,
      guardrailVersion: undefined,
    },
  });

  it('reports the capability unavailable when disabled', async () => {
    const port = createModelInferencePort(loadConfig(validEnv()));
    expect(port).toBeInstanceOf(UnavailableModelInference);
    expect(port.isAvailable()).toBe(false);
    expect(await port.converse(REQUEST)).toEqual({ ok: false, failure: 'unavailable' });
  });

  it('reports bedrock unavailable while the model id is unset', () => {
    const port = createModelInferencePort(bedrock(undefined));
    expect(port.isAvailable()).toBe(false);
  });

  // Review 2026-11-24 (#365): config already refuses this, so the factory is a second fail-closed
  // layer; a STAGING config without the relay never reaches Bedrock from the VPC.
  it('never builds the direct adapter in STAGING without the relay', () => {
    const port = createModelInferencePort({ ...bedrock('test-model-id'), environment: 'STAGING' });
    expect(port).toBeInstanceOf(UnavailableModelInference);
  });

  it('builds the Bedrock adapter once a model id is set', () => {
    const port = createModelInferencePort(bedrock('test-model-id'));
    expect(port).toBeInstanceOf(BedrockModelInference);
    expect(port.isAvailable()).toBe(true);
  });

  it('wires the content-free outcome logger into the Bedrock adapter (C-14)', () => {
    const logger = (): void => undefined;
    const withLogger = createModelInferencePort(bedrock('test-model-id'), logger);
    const byDefault = createModelInferencePort(bedrock('test-model-id'));
    expect((withLogger as unknown as { logger: unknown }).logger).toBe(logger);
    expect((byDefault as unknown as { logger: unknown }).logger).toBe(consoleInferenceLogger);
  });

  // R17.3 (contributor proposal, not released): STAGING reaches Bedrock only through the relay.
  it('builds the relay port for STAGING bedrock with a relay function', () => {
    const port = createModelInferencePort(
      loadConfig(
        validEnv({
          SUAS_ENV: 'STAGING',
          SUAS_MODEL_INFERENCE_MODE: 'bedrock',
          SUAS_AWS_REGION: 'us-east-2',
          SUAS_BEDROCK_MODEL_ID: 'us.anthropic.test-model',
          SUAS_MODEL_INFERENCE_RELAY_FUNCTION: 'suas-inference-relay',
          SUAS_BEDROCK_GUARDRAIL_ID: 'abc123def456',
          SUAS_BEDROCK_GUARDRAIL_VERSION: '1',
        }),
      ),
    );
    expect(port).toBeInstanceOf(LambdaRelayModelInference);
    expect(port.implementation).toBe('bedrock-relay');
  });

  it('builds the scripted fake for fake mode', () => {
    const port = createModelInferencePort(
      loadConfig(validEnv({ SUAS_MODEL_INFERENCE_MODE: 'fake' })),
    );
    expect(port).toBeInstanceOf(ScriptedModelInference);
  });
});
