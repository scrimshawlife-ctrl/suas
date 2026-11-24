/**
 * Inference relay (R17.3, contributor proposal, not released): the in-VPC port's failure
 * mapping, and the outside-VPC function's STAGING-only, content-free handling. No test
 * reaches AWS.
 */

import type { ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import type { InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInferenceRelayHandler,
  type InferenceRelayDeps,
  type InferenceRelayLogRecord,
} from '../../src/aws/inference-relay-lambda.js';
import {
  LambdaRelayModelInference,
  type ModelInferenceLogRecord,
  type ModelTurnRequest,
} from '../../src/inference/index.js';
import { awsError, ScriptedAwsClient } from '../helpers/aws-fake-client.js';

const SENSITIVE = 'zz-private I need a ride, my address is 12 Example Lane';

const REQUEST: ModelTurnRequest = {
  system: 'You help fill in a request form.',
  messages: [{ role: 'user', parts: [{ type: 'text', text: SENSITIVE, guarded: true }] }],
  tools: [],
  purpose: 'intake',
  deadlineMs: 20_000,
  maxTokens: 800,
};

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const invoked = (partial: { FunctionError?: string; Payload?: Uint8Array }) =>
  ({ $metadata: {}, StatusCode: 200, ...partial }) as InvokeCommandOutput;
const lambdaError = (name: string, status: number) =>
  Object.assign(awsError(name), { $metadata: { httpStatusCode: status } });

function relayPort(responses: Array<InvokeCommandOutput | Error>) {
  const client = new ScriptedAwsClient<InvokeCommandOutput>(responses);
  const logs: ModelInferenceLogRecord[] = [];
  const port = new LambdaRelayModelInference({
    functionName: 'suas-inference-relay',
    region: 'us-east-2',
    client,
    logger: (record) => logs.push(record),
  });
  return { client, port, logs };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LambdaRelayModelInference', () => {
  it('invokes the relay with purpose, request and remaining deadline', async () => {
    const answer = { ok: true, text: 'ok', toolCalls: [] };
    const { client, port } = relayPort([invoked({ Payload: encode(answer) })]);
    expect(await port.converse(REQUEST)).toEqual(answer);
    const input = client.commands[0]?.input as { FunctionName: string; Payload: Uint8Array };
    expect(input.FunctionName).toBe('suas-inference-relay');
    expect(JSON.parse(new TextDecoder().decode(input.Payload))).toEqual({
      purpose: 'intake',
      request: REQUEST,
      // 20 s asked, capped at the intake call cap plus the relay overhead.
      deadlineMs: 17_000,
    });
  });

  it.each([
    ['a Lambda throttle', lambdaError('TooManyRequestsException', 429), 'unavailable'],
    ['a Lambda 5xx', lambdaError('ServiceException', 500), 'unavailable'],
    ['a missing grant', lambdaError('AccessDeniedException', 403), 'unavailable'],
    ['a lost connection', awsError('ECONNRESET'), 'unavailable'],
    ['an abort', awsError('AbortError'), 'timeout'],
    ['a client timeout', awsError('TimeoutError'), 'timeout'],
    [
      'a function error',
      invoked({ FunctionError: 'Unhandled', Payload: encode({}) }),
      'unavailable',
    ],
    ['a payload that is not JSON', invoked({ Payload: new TextEncoder().encode('{') }), 'invalid'],
    ['a payload of the wrong shape', invoked({ Payload: encode({ ok: true }) }), 'invalid'],
    ['no payload', invoked({}), 'invalid'],
  ] as const)('maps %s to %s without throwing', async (_name, response, failure) => {
    const { port, logs } = relayPort([response]);
    expect(await port.converse(REQUEST)).toEqual({ ok: false, failure });
    expect(logs).toEqual([{ implementation: 'bedrock-relay', ok: false, failure }]);
  });

  it('passes the relay’s typed failure through', async () => {
    const { port } = relayPort([invoked({ Payload: encode({ ok: false, failure: 'refused' }) })]);
    expect(await port.converse(REQUEST)).toEqual({ ok: false, failure: 'refused' });
  });

  it('answers timeout without invoking when no time is left', async () => {
    const { client, port } = relayPort([]);
    expect(await port.converse({ ...REQUEST, deadlineMs: 0 })).toEqual({
      ok: false,
      failure: 'timeout',
    });
    expect(client.commands).toHaveLength(0);
  });

  // R17.3 (contributor's call, D-064, review 2026-11-24): the relay never waits longer than the
  // purpose's call cap plus a margin, whatever deadline the caller sends or omits.
  const { purpose: _purpose, deadlineMs: _deadline, ...UNNAMED } = REQUEST;
  it.each([
    ['no purpose and no deadline', UNNAMED, 'intake', 17_000],
    ['an intake turn asking for 20 s', { ...REQUEST, deadlineMs: 20_000 }, 'intake', 17_000],
    [
      'extraction asking for 60 s',
      { ...REQUEST, purpose: 'extraction', deadlineMs: 60_000 },
      'extraction',
      28_000,
    ],
    ['an intake turn with 9 s left', { ...REQUEST, deadlineMs: 9_000 }, 'intake', 9_000],
  ] as const)('caps the relay deadline for %s', async (_name, request, purpose, deadlineMs) => {
    const answer = { ok: true, text: 'ok', toolCalls: [] };
    const { client, port } = relayPort([invoked({ Payload: encode(answer) })]);
    await port.converse(request);
    const input = client.commands[0]?.input as { Payload: Uint8Array };
    expect(JSON.parse(new TextDecoder().decode(input.Payload))).toMatchObject({
      purpose,
      deadlineMs,
    });
  });
});

const ENDED = {
  $metadata: {},
  stopReason: 'end_turn',
  output: { message: { role: 'assistant', content: [{ text: `echo ${SENSITIVE}` }] } },
} as unknown as ConverseCommandOutput;

function relayHandler(
  overrides: Partial<InferenceRelayDeps>,
  responses: Array<ConverseCommandOutput | Error> = [ENDED],
) {
  const client = new ScriptedAwsClient<ConverseCommandOutput>(responses);
  const logs: InferenceRelayLogRecord[] = [];
  const handler = createInferenceRelayHandler({
    environment: 'STAGING',
    region: 'us-east-2',
    modelId: 'us.anthropic.test-model',
    guardrailId: 'gr-test',
    guardrailVersion: '1',
    log: (record) => logs.push(record),
    client,
    ...overrides,
  });
  return { client, handler, logs };
}

const EVENT = { purpose: 'extraction', request: REQUEST, deadlineMs: 25_000 };

describe('inference relay function', () => {
  it.each(['PRODUCTION', 'LOCAL', 'TEST', undefined])(
    'refuses outside STAGING (%s) without calling Bedrock',
    async (environment) => {
      const { client, handler, logs } = relayHandler({ environment });
      expect(await handler(EVENT)).toEqual({ ok: false, failure: 'unavailable' });
      expect(client.commands).toHaveLength(0);
      expect(logs).toEqual([{ msg: 'inference_relay_refused', reason: 'environment' }]);
    },
  );

  it.each(['modelId', 'guardrailId', 'guardrailVersion', 'region'] as const)(
    'fails closed when %s is missing',
    async (missing) => {
      const { client, handler } = relayHandler({ [missing]: undefined });
      expect(await handler(EVENT)).toEqual({ ok: false, failure: 'unavailable' });
      expect(client.commands).toHaveLength(0);
    },
  );

  it('refuses a malformed event as invalid', async () => {
    const { client, handler } = relayHandler({});
    expect(await handler({ ...EVENT, purpose: 'chat' })).toEqual({ ok: false, failure: 'invalid' });
    expect(client.commands).toHaveLength(0);
  });

  it('calls Bedrock with the guardrail and the event’s purpose bounds', async () => {
    const { client, handler } = relayHandler({});
    const result = await handler({ ...EVENT, request: { ...REQUEST, maxTokens: 99_999 } });
    expect(result).toMatchObject({ ok: true });
    expect(client.commands[0]?.input).toMatchObject({
      modelId: 'us.anthropic.test-model',
      inferenceConfig: { maxTokens: 2048 },
      guardrailConfig: { guardrailIdentifier: 'gr-test', guardrailVersion: '1', trace: 'disabled' },
      messages: [{ role: 'user', content: [{ guardContent: { text: { text: SENSITIVE } } }] }],
    });
  });

  it('logs outcomes only, never the request or reply text', async () => {
    const console = vi.spyOn(globalThis.console, 'info');
    const { handler, logs } = relayHandler({}, [ENDED, awsError('ThrottlingException')]);
    await handler(EVENT);
    await handler(EVENT);
    await handler({ ...EVENT, request: { ...REQUEST, system: 1 } });
    expect(logs).toEqual([
      { msg: 'model_inference', implementation: 'bedrock', ok: true },
      { msg: 'model_inference', implementation: 'bedrock', ok: false, failure: 'unavailable' },
      { msg: 'inference_relay_refused', reason: 'request' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('zz-private');
    expect(console).not.toHaveBeenCalled();
  });
});
