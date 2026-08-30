/**
 * Resend EmailPort (ARCHITECTURE.md §11; NOTIFICATIONS.md §2, §6, §10–§11).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  ChallengeDeliveryFailedError,
  ChannelBackedChallengeDelivery,
  createChallengeDelivery,
  outboundMessageFromChallenge,
} from '../../src/auth/index.js';
import { loadConfig } from '../../src/config/index.js';
import {
  createChannelRegistry,
  createResendEmailChannel,
  RecordingChannel,
  RESEND_EMAILS_URL,
  RESEND_IDEMPOTENCY_KEY_MAX_LENGTH,
  RESEND_IMPLEMENTATION,
  ResendEmailMisconfiguredError,
  type FetchTransport,
  type OutboundMessage,
  ResendEmailChannel,
  type ResendEmailLogRecord,
} from '../../src/notifications/index.js';
import { validEnv } from '../helpers/env.js';

const FROM = 'sender@example.invalid';
const API_KEY = 'test-resend-key-not-a-secret';
const DESTINATION = 'veteran@example.invalid';

class ScriptedTransport implements FetchTransport {
  readonly calls: { url: string; init: RequestInit }[] = [];

  constructor(
    private readonly responses: Array<Response | Error>,
    private readonly onCall?: (init: RequestInit) => void,
  ) {}

  fetch(url: string, init: RequestInit): Promise<Response> {
    this.calls.push({ url, init });
    this.onCall?.(init);
    const next = this.responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? Response.json({ id: 'missing' }));
  }
}

function requestBody(init: RequestInit): string {
  if (typeof init.body === 'string') return init.body;
  throw new Error('expected a string request body');
}

function message(overrides: Partial<OutboundMessage> = {}) {
  return {
    channel: 'EMAIL' as const,
    destination: DESTINATION,
    templateVersion: 'followup@1',
    subject: 'SUAS Follow-Up is due',
    body: 'synthetic message body that must not appear in logs',
    html: '<p>synthetic html that must not appear in logs</p>',
    idempotencyKey: 'notify-1',
    ...overrides,
  };
}

function emailChannel(
  transport: FetchTransport,
  logs: ResendEmailLogRecord[] = [],
): ResendEmailChannel {
  return createResendEmailChannel({
    apiKey: API_KEY,
    fromAddress: FROM,
    transport,
    logger: (record) => {
      logs.push(record);
    },
  });
}

describe('ResendEmailChannel', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accepts a send and returns the opaque Resend id', async () => {
    const transport = new ScriptedTransport([
      Response.json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' }),
    ]);
    const result = await emailChannel(transport).send(message());

    expect(result).toEqual({
      accepted: true,
      providerReference: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794',
    });
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.url).toBe(RESEND_EMAILS_URL);
    expect(transport.calls[0]?.init.method).toBe('POST');
    expect(transport.calls[0]?.init.headers).toMatchObject({
      Authorization: `Bearer ${API_KEY}`,
      'Idempotency-Key': 'notify-1',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(requestBody(transport.calls[0]?.init ?? {})) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
      html: string;
    };
    expect(body.from).toBe(FROM);
    expect(body.to).toEqual([DESTINATION]);
    expect(body.subject).toBe('SUAS Follow-Up is due');
    expect(body.text).toBe('synthetic message body that must not appear in logs');
    expect(body.html).toBe('<p>synthetic html that must not appear in logs</p>');
  });

  it('reads a wrapped { data, error } success payload', async () => {
    const transport = new ScriptedTransport([
      Response.json({ data: { id: 'resend-wrapped-id' }, error: null }),
    ]);
    const result = await emailChannel(transport).send(message());
    expect(result.accepted).toBe(true);
    expect(result.providerReference).toBe('resend-wrapped-id');
  });

  it('maps a provider error payload to accepted false without leaking status strings', async () => {
    const transport = new ScriptedTransport([
      Response.json({
        data: null,
        error: { name: 'validation_error', message: 'invalid from' },
      }),
    ]);
    const result = await emailChannel(transport).send(message());
    expect(result).toEqual({ accepted: false, failureReason: 'not_accepted' });
    expect(result.failureReason).not.toContain('validation_error');
    expect(JSON.stringify(result)).not.toContain('invalid from');
  });

  it('maps a non-OK HTTP response to accepted false', async () => {
    const transport = new ScriptedTransport([
      Response.json({ statusCode: 429, name: 'rate_limit_exceeded' }, { status: 429 }),
    ]);
    const result = await emailChannel(transport).send(message());
    expect(result.accepted).toBe(false);
    expect(result.failureReason).toBe('not_accepted');
    expect(JSON.stringify(result)).not.toContain('rate_limit_exceeded');
    expect(JSON.stringify(result)).not.toContain('429');
  });

  it('maps timeout or abort to accepted false', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const transport = new ScriptedTransport([timeout]);
    const result = await emailChannel(transport).send(message());
    expect(result).toEqual({ accepted: false, failureReason: 'timeout' });
  });

  it('uses the shared outbound fetch helper for the timeout signal', async () => {
    let seen: RequestInit | undefined;
    const stub: typeof fetch = (_input, init) => {
      seen = init;
      return Promise.resolve(Response.json({ id: 'from-default-transport' }));
    };
    globalThis.fetch = stub;

    const adapter = createResendEmailChannel({ apiKey: API_KEY, fromAddress: FROM });
    const result = await adapter.send(message());
    expect(result.accepted).toBe(true);
    expect(seen?.signal).toBeDefined();
    expect(seen?.signal?.aborted).toBe(false);
  });

  it('never logs the body, Authorization header, or API key', async () => {
    const logs: ResendEmailLogRecord[] = [];
    const transport = new ScriptedTransport([Response.json({ id: 'logged-id' })]);
    await emailChannel(transport, logs).send(message());

    expect(logs).toEqual([
      {
        implementation: RESEND_IMPLEMENTATION,
        channel: 'EMAIL',
        accepted: true,
        outcome: 'accepted',
      },
    ]);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('Authorization');
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain('synthetic message body');
    expect(serialized).not.toContain('synthetic html');
    expect(serialized).not.toContain(DESTINATION);
    expect(serialized).not.toContain(FROM);
  });

  it('refuses to construct without the API key or from address', () => {
    expect(() => createResendEmailChannel({ apiKey: undefined, fromAddress: FROM })).toThrow(
      ResendEmailMisconfiguredError,
    );
    expect(() => createResendEmailChannel({ apiKey: API_KEY, fromAddress: undefined })).toThrow(
      ResendEmailMisconfiguredError,
    );
    expect(() => createResendEmailChannel({ apiKey: '', fromAddress: FROM })).toThrow(
      ResendEmailMisconfiguredError,
    );
    expect(() => createResendEmailChannel({ apiKey: '   ', fromAddress: FROM })).toThrow(
      ResendEmailMisconfiguredError,
    );
    expect(() => createResendEmailChannel({ apiKey: API_KEY, fromAddress: '' })).toThrow(
      ResendEmailMisconfiguredError,
    );
  });

  it('does not accept EMAIL without a rendered subject and html', async () => {
    const transport = new ScriptedTransport([]);
    const result = await emailChannel(transport).send({
      channel: 'EMAIL',
      destination: DESTINATION,
      templateVersion: 'followup@1',
      body: 'synthetic message body that must not appear in logs',
      idempotencyKey: 'notify-1',
    });
    expect(result.accepted).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it('does not accept EMAIL with empty subject or html', async () => {
    const transport = new ScriptedTransport([]);
    const blankSubject = await emailChannel(transport).send({
      channel: 'EMAIL',
      destination: DESTINATION,
      templateVersion: 'followup@1',
      subject: '   ',
      body: 'synthetic message body that must not appear in logs',
      html: '<p>synthetic</p>',
      idempotencyKey: 'notify-blank-subject',
    });
    const blankHtml = await emailChannel(transport).send({
      channel: 'EMAIL',
      destination: DESTINATION,
      templateVersion: 'followup@1',
      subject: 'Synthetic subject',
      body: 'synthetic message body that must not appear in logs',
      html: '',
      idempotencyKey: 'notify-blank-html',
    });
    expect(blankSubject.accepted).toBe(false);
    expect(blankHtml.accepted).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it('rejects an idempotency key longer than 256 characters', async () => {
    const transport = new ScriptedTransport([]);
    const result = await emailChannel(transport).send(
      message({ idempotencyKey: 'k'.repeat(RESEND_IDEMPOTENCY_KEY_MAX_LENGTH + 1) }),
    );
    expect(result.accepted).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('challenge delivery uses the same EMAIL port', () => {
  it('sends magic-link and EMAIL_OTP through ResendEmailChannel.send', async () => {
    const transport = new ScriptedTransport([
      Response.json({ id: 'challenge-1' }),
      Response.json({ id: 'challenge-2' }),
    ]);
    const email = emailChannel(transport);
    const delivery = new ChannelBackedChallengeDelivery('sink', email, undefined);

    await delivery.deliver({
      channel: 'EMAIL',
      destination: DESTINATION,
      method: 'EMAIL_OTP',
      secret: '123456',
      expiresAt: new Date('2026-08-26T21:00:00.000Z'),
      idempotencyKey: 'auth-otp-1',
    });
    await delivery.deliver({
      channel: 'EMAIL',
      destination: DESTINATION,
      method: 'MAGIC_LINK',
      secret: 'opaque-token',
      expiresAt: new Date('2026-08-26T21:05:00.000Z'),
      idempotencyKey: 'auth-link-1',
    });

    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[0]?.init.headers).toMatchObject({
      'Idempotency-Key': 'auth-otp-1',
    });
    const first = JSON.parse(requestBody(transport.calls[0]?.init ?? {})) as {
      subject: string;
      text: string;
      html: string;
    };
    const second = JSON.parse(requestBody(transport.calls[1]?.init ?? {})) as {
      subject: string;
      text: string;
      html: string;
    };
    expect(first.subject).toBe('SUAS sign-in code');
    expect(first.text).toContain('123456');
    expect(first.html).toContain('123456');
    expect(second.subject).toBe('SUAS sign-in token');
    expect(second.text).toContain('opaque-token');
    expect(second.html).toContain('opaque-token');
    expect(delivery.implementation).toBe(RESEND_IMPLEMENTATION);

    const logs: ResendEmailLogRecord[] = [];
    const logged = emailChannel(
      new ScriptedTransport([Response.json({ id: 'logged-challenge' })]),
      logs,
    );
    const loggedDelivery = new ChannelBackedChallengeDelivery('sink', logged, undefined);
    await loggedDelivery.deliver({
      channel: 'EMAIL',
      destination: DESTINATION,
      method: 'EMAIL_OTP',
      secret: '123456',
      expiresAt: new Date('2026-08-26T21:00:00.000Z'),
      idempotencyKey: 'auth-otp-log',
    });
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain(DESTINATION);
  });

  it('does not fake success when Resend does not accept the challenge', async () => {
    const transport = new ScriptedTransport([
      Response.json({ error: { name: 'validation_error' } }),
    ]);
    const delivery = new ChannelBackedChallengeDelivery('sink', emailChannel(transport), undefined);
    await expect(
      delivery.deliver({
        channel: 'EMAIL',
        destination: DESTINATION,
        method: 'EMAIL_OTP',
        secret: '123456',
        expiresAt: new Date('2026-08-26T21:00:00.000Z'),
        idempotencyKey: 'auth-fail-1',
      }),
    ).rejects.toThrow(ChallengeDeliveryFailedError);
  });

  it('maps a challenge onto the notification outbound message', () => {
    const mapped = outboundMessageFromChallenge({
      channel: 'EMAIL',
      destination: DESTINATION,
      method: 'EMAIL_OTP',
      secret: '654321',
      expiresAt: new Date('2026-08-26T22:00:00.000Z'),
    });
    expect(mapped.channel).toBe('EMAIL');
    expect(mapped.subject).toBe('SUAS sign-in code');
    expect(mapped.body).toContain('654321');
    expect(mapped.html).toContain('654321');
    expect(mapped.templateVersion).toBe('auth.email_otp');
    expect(mapped.idempotencyKey).toContain('EMAIL_OTP');
  });
});

describe('ENVIRONMENT.md §3 — Resend is the released EMAIL mode', () => {
  it('constructs ResendEmailChannel only when the mode is selected', () => {
    const config = loadConfig(
      validEnv({
        SUAS_ENV: 'STAGING',
        SUAS_EMAIL_MODE: 'resend',
        RESEND_API_KEY: API_KEY,
        SUAS_EMAIL_FROM: FROM,
      }),
    );
    const registry = createChannelRegistry(config);
    const email = registry.get('EMAIL');
    expect(email).toBeInstanceOf(ResendEmailChannel);
    expect(email?.implementation).toBe(RESEND_IMPLEMENTATION);
  });

  it('keeps fake mode on the recording port', () => {
    const config = loadConfig(
      validEnv({
        SUAS_EMAIL_MODE: 'fake',
        RESEND_API_KEY: API_KEY,
        SUAS_EMAIL_FROM: FROM,
      }),
    );
    const delivery = createChallengeDelivery(config, createChannelRegistry(config));
    expect(delivery.implementation).toBe('recording-fake');
    expect(createChannelRegistry(config).get('EMAIL')).toBeInstanceOf(RecordingChannel);
  });
});
