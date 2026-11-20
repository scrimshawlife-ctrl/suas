/**
 * EMAIL through the outside-VPC relay (suas #305): the in-VPC channel that invokes the relay,
 * and the relay function that sends through Resend. No test reaches AWS or Resend.
 */

import type { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmailRelayHandler } from '../../src/aws/email-relay-lambda.js';
import { loadConfig } from '../../src/config/index.js';
import { createChannelRegistry, type OutboundMessage } from '../../src/notifications/channels.js';
import { LambdaRelayEmailChannel } from '../../src/notifications/lambda-relay-sender.js';
import type { FetchTransport } from '../../src/notifications/resend-email.js';
import { stagingRecipientAllowed } from '../../src/notifications/staging-recipients.js';
import { validEnv } from '../helpers/env.js';

// Routable addresses are built at run time (repository hygiene, TESTING.md §12).
const at = (local: string, domain: string) => [local, domain].join('@');
const FRIEND = at('friend', 'gmail.com');
const TO = 'recipient@example.invalid';
const FROM = 'SUAS Staging <staging@example.invalid>';
const API_KEY = 'test-resend-key-not-a-secret';
const SECRET = JSON.stringify({ RESEND_API_KEY: API_KEY });

const message = (overrides: Partial<OutboundMessage> = {}): OutboundMessage => ({
  channel: 'EMAIL',
  destination: TO,
  templateVersion: 'invite@1',
  subject: 'Subject line',
  body: 'Body text',
  html: '<p>Body text</p>',
  idempotencyKey: 'invite:1',
  ...overrides,
});

const request = {
  to: TO,
  template_version: 'invite@1',
  subject: 'Subject line',
  text: 'Body text',
  html: '<p>Body text</p>',
  idempotency_key: 'invite:1',
};

class ScriptedLambda {
  readonly commands: InvokeCommand[] = [];
  constructor(private readonly outcome: InvokeCommandOutput | Error) {}
  send(command: InvokeCommand): Promise<InvokeCommandOutput> {
    this.commands.push(command);
    return this.outcome instanceof Error
      ? Promise.reject(this.outcome)
      : Promise.resolve(this.outcome);
  }
}

const answered = (value: unknown): InvokeCommandOutput => ({
  $metadata: {},
  StatusCode: 200,
  Payload: new TextEncoder().encode(JSON.stringify(value)) as NonNullable<
    InvokeCommandOutput['Payload']
  >,
});

const relayChannel = (outcome: InvokeCommandOutput | Error) => {
  const client = new ScriptedLambda(outcome);
  const channel = new LambdaRelayEmailChannel({
    functionName: 'relay',
    region: 'us-west-2',
    client,
    allowRecipient: stagingRecipientAllowed(undefined),
  });
  return { client, channel };
};

class ScriptedTransport implements FetchTransport {
  readonly calls: { url: string; init: RequestInit }[] = [];
  constructor(private readonly responses: Response[]) {}
  fetch(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    return Promise.resolve(this.responses.shift() ?? Response.json({}, { status: 500 }));
  }
}

describe('relay channel (API and job worker)', () => {
  it('is the resend channel when the relay function is configured', () => {
    const config = loadConfig(
      validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_EMAIL_MODE: 'resend',
        SUAS_EMAIL_RELAY_FUNCTION: 'suas-email-relay',
        SUAS_AWS_REGION: 'us-west-2',
      }),
    );
    const email = createChannelRegistry(config).get('EMAIL');
    expect(email).toBeInstanceOf(LambdaRelayEmailChannel);
    expect(email?.implementation).toBe('resend');
  });

  it('refuses an off-list address before any invoke, for good', async () => {
    const { client, channel } = relayChannel(answered({ accepted: true }));
    expect(await channel.send(message({ destination: FRIEND }))).toEqual({
      accepted: false,
      retryable: false,
      failureReason: 'recipient_not_allowed',
    });
    expect(client.commands).toHaveLength(0);
  });

  it('sends the rendered message with its idempotency key and returns the relay acknowledgement', async () => {
    const { client, channel } = relayChannel(
      answered({ accepted: true, provider_reference: 'resend-id' }),
    );
    expect(await channel.send(message())).toEqual({
      accepted: true,
      providerReference: 'resend-id',
    });
    const sent: unknown = JSON.parse(
      new TextDecoder().decode(client.commands[0]?.input.Payload as Uint8Array),
    );
    expect(sent).toEqual(request);
  });

  it('passes a non-retryable refusal back unchanged', async () => {
    const { channel } = relayChannel(
      answered({ accepted: false, retryable: false, failure_reason: 'not_accepted' }),
    );
    expect(await channel.send(message())).toEqual({
      accepted: false,
      retryable: false,
      failureReason: 'not_accepted',
    });
  });

  // bb846415: a lost answer may follow a send, so it is never retried blindly.
  it.each([
    ['an invoke timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['a reset connection', Object.assign(new Error('lost'), { code: 'ECONNRESET' })],
    ['a relay crash', { $metadata: {}, FunctionError: 'Unhandled' }],
    ['an unreadable answer', answered({ result: 'sent' })],
  ])('reads %s as ambiguous, not retryable', async (_, outcome) => {
    const { channel } = relayChannel(outcome);
    expect(await channel.send(message())).toEqual({
      accepted: false,
      retryable: false,
      failureReason: 'relay_ambiguous_ack',
    });
  });

  it('retries an invoke Lambda refused before running the relay', async () => {
    const throttled = Object.assign(new Error('rate'), { name: 'TooManyRequestsException' });
    const result = await relayChannel(throttled).channel.send(message());
    expect(result).toEqual({ accepted: false, failureReason: 'relay_unavailable' });
  });
});

describe('relay function', () => {
  const handlerWith = (
    options: { secret?: string | undefined; transport?: ScriptedTransport } = {},
  ) => {
    let reads = 0;
    const transport = options.transport ?? new ScriptedTransport([]);
    const handler = createEmailRelayHandler({
      readSecret: () => {
        reads += 1;
        return Promise.resolve('secret' in options ? options.secret : SECRET);
      },
      fromAddress: FROM,
      allowRecipient: stagingRecipientAllowed(undefined),
      transport,
    });
    return { handler, transport, reads: () => reads };
  };

  it('refuses a malformed request for good, before it reads the secret', async () => {
    const { handler, reads } = handlerWith();
    for (const bad of [{ ...request, to: 'not-an-address' }, { ...request, extra: true }, null]) {
      expect(await handler(bad)).toEqual({
        accepted: false,
        retryable: false,
        failure_reason: 'invalid_message',
      });
    }
    expect(reads()).toBe(0);
  });

  it('refuses an off-list address for good, before it reads the secret', async () => {
    const { handler, transport, reads } = handlerWith();
    expect(await handler({ ...request, to: FRIEND })).toEqual({
      accepted: false,
      retryable: false,
      failure_reason: 'recipient_not_allowed',
    });
    expect(reads()).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it.each([
    ['missing', undefined],
    ['the placeholder', JSON.stringify({ RESEND_API_KEY: '', placeholder: 'x' })],
    ['not JSON', 'not json'],
  ])('retries with nothing sent when the secret is %s', async (_, secret) => {
    const { handler, transport } = handlerWith({ secret });
    expect(await handler(request)).toEqual({
      accepted: false,
      failure_reason: 'relay_not_configured',
    });
    expect(transport.calls).toHaveLength(0);
  });

  it('sends through Resend with the key, sender and idempotency key, and passes the acknowledgement back', async () => {
    const transport = new ScriptedTransport([
      Response.json({ id: 'resend-id' }),
      Response.json({ id: 'resend-id-2' }),
      Response.json({ name: 'validation_error' }, { status: 422 }),
    ]);
    const { handler, reads } = handlerWith({ transport });
    expect(await handler(request)).toEqual({ accepted: true, provider_reference: 'resend-id' });
    expect(await handler(request)).toEqual({ accepted: true, provider_reference: 'resend-id-2' });
    expect(reads()).toBe(1);
    expect(transport.calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Idempotency-Key': 'invite:1',
    });
    expect(JSON.parse(transport.calls[0]?.init.body as string)).toMatchObject({
      from: FROM,
      to: [TO],
      subject: 'Subject line',
    });
    expect(await handler(request)).toEqual({
      accepted: false,
      retryable: false,
      failure_reason: 'not_accepted',
    });
  });
});

// R16.1 (contributor proposal, not released): the relay reads its own SUAS_PUBLIC_DEMO, so an
// API in demo mode cannot open the relay's allowlist alone (defence in depth).
describe('relay function in public demo mode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const relayFromEnv = (demo: string | undefined) => {
    vi.stubEnv('SUAS_EMAIL_SECRET_ID', '');
    vi.stubEnv('SUAS_STAGING_FIXTURE_MAILBOX', '');
    vi.stubEnv('SUAS_PUBLIC_DEMO', demo);
    return createEmailRelayHandler();
  };

  it('allows any address with SUAS_PUBLIC_DEMO=enabled and refuses it when unset', async () => {
    // Past the allowlist, the unset secret is the next refusal; nothing reaches AWS or Resend.
    expect(await relayFromEnv('enabled')({ ...request, to: FRIEND })).toEqual({
      accepted: false,
      failure_reason: 'relay_not_configured',
    });
    expect(await relayFromEnv(undefined)({ ...request, to: FRIEND })).toEqual({
      accepted: false,
      retryable: false,
      failure_reason: 'recipient_not_allowed',
    });
  });
});
