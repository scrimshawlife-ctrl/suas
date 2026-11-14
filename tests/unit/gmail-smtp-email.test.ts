/**
 * Gmail SMTP EMAIL provider (suas-specs #75 R11.2, proposal): configuration guards, the
 * SMTP status mapping (250 / 5xx / 4xx / timeout), the relay invoke and the relay
 * function's contract. No test reaches smtp.gmail.com or AWS.
 */

import type { Readable } from 'node:stream';
import type { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import { createSmtpRelayHandler } from '../../src/aws/smtp-relay-lambda.js';
import { describeConfig, loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { createChannelRegistry } from '../../src/notifications/channels.js';
import {
  GmailSmtpEmailChannel,
  stagingRecipientAllowed,
  type GmailSmtpEmailLogRecord,
} from '../../src/notifications/gmail-smtp-email.js';
import {
  GmailSmtpSender,
  type SmtpConnectionLike,
  type SmtpErrorLike,
} from '../../src/notifications/gmail-smtp-sender.js';
import { LambdaRelaySmtpSender } from '../../src/notifications/lambda-relay-sender.js';
import type { SmtpMessage, SmtpSendResult } from '../../src/notifications/smtp.js';
import { validEnv } from '../helpers/env.js';

const USER = 'suas.staging.sender@example.invalid';
const PASSWORD = 'test-app-password-not-a-secret';
const TO = 'recipient@example.invalid';
const MESSAGE: SmtpMessage = {
  to: TO,
  subject: 'Subject line',
  text: 'Body text',
  html: '<p>Body text</p>',
  messageId: 'a'.repeat(32),
};

function issuesFor(env: Record<string, string | undefined>): string {
  const result = tryLoadConfig(env);
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? '' : result.issues.join('\n');
}

const staging = (overrides: Record<string, string | undefined>) =>
  validEnv({ SUAS_ENV: 'STAGING', SUAS_EMAIL_MODE: 'gmail_smtp', ...overrides });

describe('gmail_smtp configuration', () => {
  it('accepts a direct send in STAGING and redacts the password', () => {
    const config = loadConfig(staging({ SUAS_SMTP_USER: USER, SUAS_SMTP_APP_PASSWORD: PASSWORD }));
    expect(config.notifications.email).toBe('gmail_smtp');
    expect(createChannelRegistry(config).get('EMAIL')).toBeInstanceOf(GmailSmtpEmailChannel);
    const described = JSON.stringify(describeConfig(config));
    expect(described).not.toContain(PASSWORD);
    expect(described).not.toContain(USER);
    expect(described).toContain('"smtp_app_password_configured":true');
  });

  it('accepts the relay without any credential in this process', () => {
    const config = loadConfig(
      staging({ SUAS_SMTP_RELAY_FUNCTION: 'suas-smtp-relay', SUAS_AWS_REGION: 'us-west-2' }),
    );
    expect(config.notifications.smtp.relayFunction).toBe('suas-smtp-relay');
    expect(createChannelRegistry(config).get('EMAIL')?.implementation).toBe('gmail_smtp');
  });

  it('is refused in LOCAL and TEST, like resend', () => {
    const extra = { SUAS_SMTP_USER: USER, SUAS_SMTP_APP_PASSWORD: PASSWORD };
    expect(issuesFor(validEnv({ SUAS_EMAIL_MODE: 'gmail_smtp', ...extra }))).toContain(
      'SUAS_EMAIL_MODE=gmail_smtp is forbidden in TEST',
    );
    expect(
      issuesFor(validEnv({ SUAS_ENV: 'LOCAL', SUAS_EMAIL_MODE: 'gmail_smtp', ...extra })),
    ).toContain('forbidden in LOCAL');
  });

  it('needs user and password for a direct send, and never the password beside the relay', () => {
    const missing = issuesFor(staging({}));
    expect(missing).toContain('SUAS_SMTP_USER is required');
    expect(missing).toContain('SUAS_SMTP_APP_PASSWORD is required');

    const both = issuesFor(
      staging({
        SUAS_SMTP_RELAY_FUNCTION: 'suas-smtp-relay',
        SUAS_SMTP_APP_PASSWORD: PASSWORD,
      }),
    );
    expect(both).toContain('SUAS_SMTP_APP_PASSWORD must not be set with SUAS_SMTP_RELAY_FUNCTION');
    expect(both).toContain('SUAS_AWS_REGION is required');
  });

  it('rejects a separate From, a malformed user and the removed ses mode', () => {
    const issues = issuesFor(
      staging({
        SUAS_SMTP_USER: 'Display Name <x@example.invalid>',
        SUAS_SMTP_APP_PASSWORD: PASSWORD,
        SUAS_EMAIL_FROM: 'other@example.invalid',
      }),
    );
    expect(issues).toContain('SUAS_SMTP_USER must be a bare email address');
    expect(issues).toContain('SUAS_EMAIL_FROM is not used with SUAS_EMAIL_MODE=gmail_smtp');
    expect(issuesFor(validEnv({ SUAS_EMAIL_MODE: 'ses' }))).toContain('SUAS_EMAIL_MODE="ses"');
  });
});

type Script =
  | { readonly at: 'connect' | 'login'; readonly error: SmtpErrorLike }
  | { readonly at: 'send'; readonly readBody: boolean; readonly error?: SmtpErrorLike }
  | { readonly at: 'hang'; readonly readBody: boolean };

/** A scripted SMTP session. `readBody` consumes the message stream, as after DATA 354. */
class FakeConnection implements SmtpConnectionLike {
  login_: { user: string; pass: string } | undefined;
  envelope: { from: string; to: string[] } | undefined;
  raw = '';
  closed = false;

  constructor(private readonly script: Script | undefined) {}

  connect(callback: (error?: SmtpErrorLike) => void): void {
    setImmediate(() =>
      this.script?.at === 'connect' ? callback(this.script.error) : callback(undefined),
    );
  }
  login(auth: { user: string; pass: string }, callback: (e: SmtpErrorLike | null) => void): void {
    this.login_ = auth;
    setImmediate(() => callback(this.script?.at === 'login' ? this.script.error : null));
  }
  send(
    envelope: { from: string; to: string[] },
    message: Readable,
    callback: (e: SmtpErrorLike | null, info: { response?: string }) => void,
  ): void {
    this.envelope = envelope;
    const script = this.script;
    const finish = (): void => {
      if (script?.at === 'hang') return;
      if (script?.at === 'send' && script.error !== undefined) return callback(script.error, {});
      callback(null, { response: '250 2.0.0 OK queued - gsmtp' });
    };
    const reads = script === undefined || ('readBody' in script && script.readBody);
    if (!reads) {
      setImmediate(finish);
      return;
    }
    message.on('data', (chunk: Buffer) => (this.raw += chunk.toString()));
    message.on('end', finish);
  }
  quit(): void {
    this.closed = true;
  }
  close(): void {
    this.closed = true;
  }
  on(): this {
    return this;
  }
}

async function sendWith(script: Script | undefined): Promise<[SmtpSendResult, FakeConnection]> {
  const connection = new FakeConnection(script);
  const sender = new GmailSmtpSender({
    user: USER,
    appPassword: PASSWORD,
    connect: () => connection,
    totalTimeoutMs: 50,
  });
  return [await sender.send(MESSAGE), connection];
}

describe('SMTP status mapping (R11.2)', () => {
  it('maps 250 to sent, from the Gmail account, with the message id', async () => {
    const [result, connection] = await sendWith(undefined);
    expect(result).toEqual({ result: 'sent', responseCode: 250 });
    expect(connection.login_).toEqual({ user: USER, pass: PASSWORD });
    expect(connection.envelope).toEqual({ from: USER, to: [TO] });
    expect(connection.raw).toContain(`From: ${USER}`);
    expect(connection.raw).toContain(`Message-ID: <${'a'.repeat(32)}@example.invalid>`);
    expect(connection.closed).toBe(true);
  });

  it('maps a permanent 5xx to rejected, before or after the data', async () => {
    expect(
      (await sendWith({ at: 'send', readBody: false, error: { responseCode: 550 } }))[0],
    ).toEqual({ result: 'rejected', responseCode: 550 });
    expect(
      (await sendWith({ at: 'send', readBody: true, error: { responseCode: 552 } }))[0],
    ).toEqual({ result: 'rejected', responseCode: 552 });
  });

  it('maps a 4xx and any failure before the data to retryable', async () => {
    expect(
      (await sendWith({ at: 'send', readBody: false, error: { responseCode: 421 } }))[0],
    ).toEqual({ result: 'retryable', responseCode: 421 });
    expect((await sendWith({ at: 'connect', error: { code: 'ETIMEDOUT' } }))[0].result).toBe(
      'retryable',
    );
    // A refused login says nothing about the message; the outbox retries after the secret is fixed.
    expect(
      (await sendWith({ at: 'login', error: { code: 'EAUTH', responseCode: 535 } }))[0].result,
    ).toBe('retryable');
    expect(
      (await sendWith({ at: 'send', readBody: false, error: { code: 'ECONNECTION' } }))[0].result,
    ).toBe('retryable');
  });

  it('maps a timeout or lost connection after the data started to an ambiguous ack', async () => {
    expect(
      (await sendWith({ at: 'send', readBody: true, error: { code: 'ETIMEDOUT' } }))[0],
    ).toEqual({
      result: 'ambiguous_ack',
    });
    // No final reply at all: the session deadline closes it.
    expect((await sendWith({ at: 'hang', readBody: true }))[0]).toEqual({
      result: 'ambiguous_ack',
    });
    expect((await sendWith({ at: 'hang', readBody: false }))[0]).toEqual({ result: 'retryable' });
  });
});

describe('GmailSmtpEmailChannel', () => {
  const outbound = {
    channel: 'EMAIL',
    destination: TO,
    templateVersion: 'alert@1',
    subject: 'Subject line',
    body: 'Body text',
    html: '<p>Body text</p>',
    idempotencyKey: `auth:EMAIL_OTP:${TO}:2026-11-12T00:00:00.000Z`,
  } as const;

  const channelFor = (result: SmtpSendResult, logs: GmailSmtpEmailLogRecord[] = []) => {
    const sent: SmtpMessage[] = [];
    const channel = new GmailSmtpEmailChannel(
      {
        implementation: 'scripted',
        send: (message) => {
          sent.push(message);
          return Promise.resolve(result);
        },
      },
      (record) => logs.push(record),
    );
    return { channel, sent };
  };

  it('acknowledges a sent message and hides the address from the message id', async () => {
    const logs: GmailSmtpEmailLogRecord[] = [];
    const { channel, sent } = channelFor({ result: 'sent', responseCode: 250 }, logs);
    const ack = await channel.send(outbound);
    expect(ack.accepted).toBe(true);
    expect(sent[0]?.messageId).toMatch(/^[0-9a-f]{32}$/);
    expect(ack.providerReference).toBe(sent[0]?.messageId);
    expect(JSON.stringify(logs)).not.toContain(TO);
    expect(JSON.stringify(logs)).not.toContain('Body text');
    expect(logs).toEqual([
      {
        implementation: 'gmail_smtp',
        channel: 'EMAIL',
        accepted: true,
        outcome: 'sent',
        response_code: 250,
      },
    ]);
  });

  it.each([
    ['rejected', false, 'smtp_rejected'],
    ['retryable', true, 'smtp_retryable_failure'],
    ['ambiguous_ack', false, 'smtp_ambiguous_ack'],
  ] as const)('maps %s to retryable=%s', async (result, retryable, failureReason) => {
    const ack = await channelFor({ result }).channel.send(outbound);
    expect(ack).toEqual({ accepted: false, retryable, failureReason });
  });
});

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

const payload = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

describe('relay invoke', () => {
  const relay = (outcome: InvokeCommandOutput | Error) => {
    const client = new ScriptedLambda(outcome);
    return {
      client,
      sender: new LambdaRelaySmtpSender({ functionName: 'relay', region: 'us-west-2', client }),
    };
  };

  it('sends the rendered message and returns the relay result', async () => {
    const { client, sender } = relay({
      $metadata: {},
      StatusCode: 200,
      Payload: payload({ result: 'sent', response_code: 250 }) as NonNullable<
        InvokeCommandOutput['Payload']
      >,
    });
    expect(await sender.send(MESSAGE)).toEqual({ result: 'sent', responseCode: 250 });
    const sentPayload = JSON.parse(
      new TextDecoder().decode(client.commands[0]?.input.Payload as Uint8Array),
    );
    expect(sentPayload).toEqual({
      to: TO,
      subject: 'Subject line',
      text: 'Body text',
      html: '<p>Body text</p>',
      message_id: 'a'.repeat(32),
    });
  });

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UnknownError'])(
    'does not blindly retry an invoke with an unknown outcome (%s)',
    async (code) => {
      const error = Object.assign(new Error('lost relay response'), { code });
      expect((await relay(error).sender.send(MESSAGE)).result).toBe('ambiguous_ack');
    },
  );

  it('reads a relay crash or invoke timeout as ambiguous, and a refused invoke as retryable', async () => {
    const crashed = relay({ $metadata: {}, FunctionError: 'Unhandled' });
    expect((await crashed.sender.send(MESSAGE)).result).toBe('ambiguous_ack');
    const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    expect((await relay(timeout).sender.send(MESSAGE)).result).toBe('ambiguous_ack');
    const throttled = Object.assign(new Error('rate'), { name: 'TooManyRequestsException' });
    expect((await relay(throttled).sender.send(MESSAGE)).result).toBe('retryable');
  });
});

describe('relay function contract', () => {
  const secret = JSON.stringify({ SUAS_SMTP_USER: USER, SUAS_SMTP_APP_PASSWORD: PASSWORD });
  const request = {
    to: TO,
    subject: 'Subject line',
    text: 'Body text',
    message_id: 'b'.repeat(32),
  };

  it('reads the secret once per container and returns the SMTP result class', async () => {
    let reads = 0;
    const received: SmtpMessage[] = [];
    const handler = createSmtpRelayHandler({
      readSecret: () => {
        reads += 1;
        return Promise.resolve(secret);
      },
      allowRecipient: () => true,
      createSender: (credentials) => {
        expect(credentials).toEqual({ SUAS_SMTP_USER: USER, SUAS_SMTP_APP_PASSWORD: PASSWORD });
        return {
          implementation: 'scripted',
          send: (message) => {
            received.push(message);
            return Promise.resolve({ result: 'sent', responseCode: 250 });
          },
        };
      },
    });
    expect(await handler(request)).toEqual({ result: 'sent', response_code: 250 });
    expect(await handler(request)).toEqual({ result: 'sent', response_code: 250 });
    expect(reads).toBe(1);
    expect(received[0]).toEqual({
      to: TO,
      subject: 'Subject line',
      text: 'Body text',
      messageId: 'b'.repeat(32),
    });
  });

  it('rejects a malformed request and retries a missing or malformed secret', async () => {
    const neverSends = () => {
      throw new Error('must not build a sender');
    };
    const handler = createSmtpRelayHandler({
      readSecret: () => Promise.resolve('{}'),
      createSender: neverSends,
      allowRecipient: () => true,
    });
    expect(await handler({ ...request, to: 'not-an-address' })).toEqual({ result: 'rejected' });
    expect(await handler({ ...request, extra: true })).toEqual({ result: 'rejected' });
    expect(await handler(request)).toEqual({ result: 'retryable' });
    const unset = createSmtpRelayHandler({
      readSecret: () => Promise.resolve(undefined),
      createSender: neverSends,
      allowRecipient: () => true,
    });
    expect(await unset(request)).toEqual({ result: 'retryable' });
  });
});

// r263 F2: a fail-closed STAGING recipient allowlist at the last hop.
describe('STAGING last-hop recipient allowlist', () => {
  // Routable addresses are built at run time (repository hygiene, TESTING.md §12).
  const at = (local: string, domain: string) => [local, domain].join('@');
  const OWNER = at('owner', 'gmail.com');
  const OWNER_TAGGED = at('owner+suas-1', 'gmail.com');
  const OTHER_TAGGED = at('other+suas-1', 'gmail.com');
  const FRIEND = at('friend', 'gmail.com');
  const MAILBOX = 'fixture.owner@example.com';
  const outbound = (destination: string) =>
    ({
      channel: 'EMAIL',
      destination,
      templateVersion: 'invite@1',
      subject: 'Subject line',
      body: 'Body text',
      idempotencyKey: 'invite:1',
    }) as const;
  const scripted = () => {
    const sent: SmtpMessage[] = [];
    const sender = {
      implementation: 'scripted',
      send: (message: SmtpMessage) => {
        sent.push(message);
        return Promise.resolve({ result: 'sent', responseCode: 250 } as const);
      },
    };
    return { sender, sent };
  };

  it('admits synthetic addresses and +tag addresses of the fixture mailbox, not the bare mailbox', () => {
    const allowed = stagingRecipientAllowed(OWNER);
    expect(allowed('a@example.invalid')).toBe(true);
    expect(allowed(OWNER_TAGGED)).toBe(true);
    expect(allowed(OWNER)).toBe(false);
    expect(allowed(OTHER_TAGGED)).toBe(false);
    expect(allowed(FRIEND)).toBe(false);
  });

  it('fails closed with no mailbox: only synthetic addresses pass', () => {
    const allowed = stagingRecipientAllowed(undefined);
    expect(allowed('a@example.invalid')).toBe(true);
    expect(allowed(OWNER_TAGGED)).toBe(false);
    expect(allowed(FRIEND)).toBe(false);
  });

  it('a destination off the list makes no SMTP call and settles not accepted, not retryable', async () => {
    const logs: GmailSmtpEmailLogRecord[] = [];
    const { sender, sent } = scripted();
    const channel = new GmailSmtpEmailChannel(
      sender,
      (record) => logs.push(record),
      stagingRecipientAllowed(MAILBOX),
    );
    expect(await channel.send(outbound(FRIEND))).toEqual({
      accepted: false,
      retryable: false,
      failureReason: 'recipient_not_allowed',
    });
    expect(sent).toHaveLength(0);
    expect(JSON.stringify(logs)).not.toContain(FRIEND);
    expect(logs).toEqual([
      {
        implementation: 'gmail_smtp',
        channel: 'EMAIL',
        accepted: false,
        outcome: 'recipient_not_allowed',
      },
    ]);
  });

  it('a destination on the list is sent', async () => {
    const { sender, sent } = scripted();
    const channel = new GmailSmtpEmailChannel(sender, undefined, stagingRecipientAllowed(MAILBOX));
    expect((await channel.send(outbound('fixture.owner+inv-2@example.com'))).accepted).toBe(true);
    expect(sent.map((m) => m.to)).toEqual(['fixture.owner+inv-2@example.com']);
  });

  it('a channel built without an allowlist refuses a real address', async () => {
    const { sender, sent } = scripted();
    const channel = new GmailSmtpEmailChannel(sender);
    expect((await channel.send(outbound(FRIEND))).accepted).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('the relay refuses an address off the list before it reads the secret', async () => {
    let reads = 0;
    const handler = createSmtpRelayHandler({
      readSecret: () => {
        reads += 1;
        return Promise.resolve(
          JSON.stringify({ SUAS_SMTP_USER: USER, SUAS_SMTP_APP_PASSWORD: PASSWORD }),
        );
      },
      createSender: () => {
        throw new Error('must not build a sender');
      },
      allowRecipient: stagingRecipientAllowed(undefined),
    });
    const request = {
      to: FRIEND,
      subject: 'Subject line',
      text: 'Body text',
      message_id: 'c'.repeat(32),
    };
    expect(await handler(request)).toEqual({ result: 'rejected' });
    expect(reads).toBe(0);
  });
});
