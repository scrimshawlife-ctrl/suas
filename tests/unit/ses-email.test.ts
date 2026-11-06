/**
 * Amazon SES EmailPort adapter (V1_PROJECT_PLAN.md §4.1; NOTIFICATIONS.md §6, §10).
 */

import type { SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { describe, expect, it } from 'vitest';
import { createChallengeDelivery, ChannelBackedChallengeDelivery } from '../../src/auth/index.js';
import { loadConfig } from '../../src/config/index.js';
import {
  createChannelRegistry,
  createSesEmailChannel,
  SES_IMPLEMENTATION,
  SesEmailChannel,
  SesEmailMisconfiguredError,
  type OutboundMessage,
  type SesClientLike,
  type SesEmailLogRecord,
} from '../../src/notifications/index.js';
import { awsError, ScriptedAwsClient } from '../helpers/aws-fake-client.js';
import { validEnv } from '../helpers/env.js';

const FROM = 'SUAS <sender@example.invalid>';

const MESSAGE: OutboundMessage = {
  channel: 'EMAIL',
  destination: 'veteran@example.invalid',
  templateVersion: 'test-v1',
  subject: 'Your sign-in code',
  body: 'Code 123456',
  html: '<p>Code 123456</p>',
  idempotencyKey: 'key-1',
};

function channelWith(
  client: ScriptedAwsClient<SendEmailCommandOutput>,
  logs?: SesEmailLogRecord[],
) {
  return createSesEmailChannel({
    region: 'us-west-2',
    fromAddress: FROM,
    client: client,
    ...(logs !== undefined ? { logger: (record) => logs.push(record) } : {}),
  });
}

describe('SES EmailPort adapter', () => {
  it('maps a MessageId to an accepted acknowledgement and sends the SES payload', async () => {
    const client = new ScriptedAwsClient<SendEmailCommandOutput>([
      { MessageId: 'ses-1', $metadata: {} },
    ]);
    const ack = await channelWith(client).send(MESSAGE);

    expect(ack).toEqual({ accepted: true, providerReference: 'ses-1' });
    expect(client.commands[0]?.input).toEqual({
      FromEmailAddress: FROM,
      Destination: { ToAddresses: ['veteran@example.invalid'] },
      Content: {
        Simple: {
          Subject: { Data: 'Your sign-in code', Charset: 'UTF-8' },
          Body: {
            Text: { Data: 'Code 123456', Charset: 'UTF-8' },
            Html: { Data: '<p>Code 123456</p>', Charset: 'UTF-8' },
          },
        },
      },
    });
    expect(client.commands[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['a missing MessageId', { $metadata: {} }, 'not_accepted'],
    ['a rejected message', awsError('MessageRejected'), 'not_accepted'],
    ['a throttled call', awsError('TooManyRequestsException'), 'not_accepted'],
    ['an aborted call', awsError('AbortError'), 'timeout'],
    ['a client timeout', awsError('TimeoutError'), 'timeout'],
  ])('reports %s as not accepted without throwing', async (_label, response, reason) => {
    const ack = await channelWith(new ScriptedAwsClient<SendEmailCommandOutput>([response])).send(
      MESSAGE,
    );
    expect(ack).toEqual({ accepted: false, failureReason: reason });
  });

  it('rejects a message without subject or html before calling SES', async () => {
    const client = new ScriptedAwsClient<SendEmailCommandOutput>([]);
    const channel = channelWith(client);
    const { subject: _s, ...noSubject } = MESSAGE;
    expect((await channel.send(noSubject)).accepted).toBe(false);
    expect((await channel.send({ ...MESSAGE, html: ' ' })).accepted).toBe(false);
    expect(client.commands).toHaveLength(0);
  });

  it('logs only the outcome, never addresses or content', async () => {
    const logs: SesEmailLogRecord[] = [];
    await channelWith(
      new ScriptedAwsClient<SendEmailCommandOutput>([{ MessageId: 'ses-1', $metadata: {} }]),
      logs,
    ).send(MESSAGE);
    expect(logs).toEqual([
      { implementation: 'ses', channel: 'EMAIL', accepted: true, outcome: 'accepted' },
    ]);
    expect(JSON.stringify(logs)).not.toContain('veteran@example.invalid');
  });

  it('fails closed without a region or from address', () => {
    const client = new ScriptedAwsClient<SendEmailCommandOutput>([]) as unknown as SesClientLike;
    expect(() => createSesEmailChannel({ region: undefined, fromAddress: FROM, client })).toThrow(
      SesEmailMisconfiguredError,
    );
    expect(() =>
      createSesEmailChannel({ region: 'us-west-2', fromAddress: undefined, client }),
    ).toThrow(SesEmailMisconfiguredError);
  });
});

describe('SES mode selection', () => {
  const stagingSes = validEnv({
    SUAS_ENV: 'STAGING',
    SUAS_EMAIL_MODE: 'ses',
    SUAS_AWS_REGION: 'us-west-2',
    SUAS_EMAIL_FROM: 'sender@example.invalid',
  });

  it('registers the SES adapter for EMAIL and keeps challenge delivery on it', () => {
    const config = loadConfig(stagingSes);
    const registry = createChannelRegistry(config);
    expect(registry.get('EMAIL')).toBeInstanceOf(SesEmailChannel);
    expect(registry.get('EMAIL')?.implementation).toBe(SES_IMPLEMENTATION);
    expect(createChallengeDelivery(config, registry)).toBeInstanceOf(
      ChannelBackedChallengeDelivery,
    );
  });
});
