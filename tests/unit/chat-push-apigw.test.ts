/**
 * API Gateway WebSocket push adapter and chat push config guards
 * (V1_PROJECT_PLAN.md §2.2, §4.3 F7). The AWS client is scripted: no AWS call is made.
 */

import type { PostToConnectionCommandOutput } from '@aws-sdk/client-apigatewaymanagementapi';
import { describe, expect, it } from 'vitest';
import { tryLoadConfig } from '../../src/config/index.js';
import { ApiGatewayConnectionPush, ConnectionPushError } from '../../src/realtime/index.js';
import { ScriptedAwsClient } from '../helpers/aws-fake-client.js';
import { validEnv } from '../helpers/env.js';

const ENDPOINT = 'https://abc123.execute-api.us-west-2.amazonaws.com/staging';

function sdkError(name: string, httpStatusCode: number): Error {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode } });
}

function pushWith(responses: Array<PostToConnectionCommandOutput | Error>) {
  const client = new ScriptedAwsClient<PostToConnectionCommandOutput>(responses);
  return {
    client,
    push: new ApiGatewayConnectionPush({ endpoint: ENDPOINT, region: 'us-west-2', client }),
  };
}

describe('ApiGatewayConnectionPush', () => {
  it('posts the payload to the connection and reports delivered', async () => {
    const { client, push } = pushWith([{ $metadata: {} }]);
    await expect(push.send('conn-1', '{"a":1}')).resolves.toBe('delivered');
    const input = client.commands[0]?.input as { ConnectionId: string; Data: Uint8Array };
    expect(input.ConnectionId).toBe('conn-1');
    expect(new TextDecoder().decode(input.Data)).toBe('{"a":1}');
  });

  it('reports gone on HTTP 410 so the caller can drop the registry entry', async () => {
    const { push } = pushWith([sdkError('GoneException', 410)]);
    await expect(push.send('conn-1', '{}')).resolves.toBe('gone');
  });

  it('maps any other failure to a typed push error', async () => {
    const { push } = pushWith([sdkError('ThrottlingException', 429), sdkError('TimeoutError', 0)]);
    await expect(push.send('c', '{}')).rejects.toMatchObject({ kind: 'unavailable' });
    await expect(push.send('c', '{}')).rejects.toBeInstanceOf(ConnectionPushError);
  });

  it('derives the client WebSocket URL from the management endpoint', () => {
    expect(pushWith([]).push.connectUrl()).toBe(
      'wss://abc123.execute-api.us-west-2.amazonaws.com/staging',
    );
  });
});

describe('chat push configuration', () => {
  const issues = (env: Record<string, string | undefined>): string => {
    const result = tryLoadConfig(validEnv(env));
    return result.ok ? '' : result.issues.join('\n');
  };

  it('refuses the real API Gateway mode in TEST', () => {
    expect(
      issues({
        SUAS_CHAT_PUSH_MODE: 'apigw',
        SUAS_CHAT_WS_ENDPOINT: ENDPOINT,
        SUAS_AWS_REGION: 'us-west-2',
      }),
    ).toContain('SUAS_CHAT_PUSH_MODE=apigw is forbidden in TEST');
  });

  it('refuses the process-local server outside LOCAL and TEST', () => {
    expect(issues({ SUAS_ENV: 'STAGING', SUAS_CHAT_PUSH_MODE: 'local' })).toContain(
      'SUAS_CHAT_PUSH_MODE=local is allowed only in LOCAL and TEST',
    );
  });

  it('requires a well-formed endpoint for apigw', () => {
    const base = {
      SUAS_ENV: 'STAGING',
      SUAS_CHAT_PUSH_MODE: 'apigw',
      SUAS_AWS_REGION: 'us-west-2',
    };
    expect(issues(base)).toContain('SUAS_CHAT_WS_ENDPOINT is required');
    expect(issues({ ...base, SUAS_CHAT_WS_ENDPOINT: 'http://example.com' })).toContain(
      'SUAS_CHAT_WS_ENDPOINT must be',
    );
  });
});
