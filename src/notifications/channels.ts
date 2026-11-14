/**
 * Notification channel ports.
 *
 * Spec citations:
 * - SUAS-specs NOTIFICATIONS.md §2 ("Unavailable external provider/channel must
 *   be reported unavailable; do not fake delivery"), §6 (`SENT` means the send
 *   attempt was accepted, not that it was delivered), §10 (no message bodies in
 *   ordinary logs; credentials outside domain records), §11 (provider-specific
 *   statuses must not leak into product contracts)
 * - SUAS-specs ARCHITECTURE.md §11 (`EmailPort`, `SmsPort`)
 * - SUAS-specs ENVIRONMENT.md §3 (`SUAS_EMAIL_MODE` adds D-004 `resend`;
 *   `SUAS_SMS_MODE` remains `disabled|fake|sink`.) suas-specs #75 R11.2 (proposal,
 *   not released) adds `gmail_smtp` for v1 STAGING.
 *
 * IN_APP is internal and always available: it writes to SUAS's own store rather
 * than contacting a provider, so no vendor decision gates it.
 */

import type { CommunicationMode, SuasConfig } from '../config/index.js';
import { createGmailSmtpEmailChannel, type GmailSmtpEmailLogRecord } from './gmail-smtp-email.js';
import { createResendEmailChannel, type ResendEmailLogRecord } from './resend-email.js';

export const NOTIFICATION_CHANNELS = ['EMAIL', 'SMS', 'IN_APP'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** NOTIFICATIONS.md §2: PUSH is reserved and cannot be selected. */
export const RESERVED_FUTURE_CHANNELS = ['PUSH'] as const;

export class UnknownChannelError extends Error {
  readonly code = 'VALIDATION_FAILED';
  readonly httpStatus = 400;

  constructor(channel: string) {
    const reserved = (RESERVED_FUTURE_CHANNELS as readonly string[]).includes(channel);
    super(
      reserved
        ? `"${channel}" is reserved for a future release and is not an MVP channel ` +
            `(SUAS-specs NOTIFICATIONS.md §2).`
        : `"${channel}" is not a known notification channel. MVP channels: ` +
            `${NOTIFICATION_CHANNELS.join(', ')}.`,
    );
    this.name = 'UnknownChannelError';
  }
}

export function assertNotificationChannel(channel: string): asserts channel is NotificationChannel {
  if (!(NOTIFICATION_CHANNELS as readonly string[]).includes(channel)) {
    throw new UnknownChannelError(channel);
  }
}

/**
 * NOTIFICATIONS.md §2. Raised when a channel has no delivery path, so the caller
 * reports unavailability rather than recording a send that never happened.
 */
export class ChannelUnavailableError extends Error {
  readonly code = 'CHANNEL_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(channel: NotificationChannel) {
    super(
      `The ${channel} channel has no configured delivery path, so nothing was sent ` +
        `(SUAS-specs NOTIFICATIONS.md §2).`,
    );
    this.name = 'ChannelUnavailableError';
  }
}

export interface OutboundMessage {
  readonly channel: NotificationChannel;
  /** Address or reference. For IN_APP this is the recipient user id. */
  readonly destination: string;
  /** Catalog version key. Not a human subject. */
  readonly templateVersion: string;
  /** Human subject from the renderer. Required for EMAIL. */
  readonly subject?: string;
  /**
   * Rendered text body. NOTIFICATIONS.md §10 forbids writing this to ordinary
   * application logs, and §7 forbids templates carrying safety-critical logic.
   */
  readonly body: string;
  /** Rendered HTML body. Required for EMAIL; optional for IN_APP and SMS. */
  readonly html?: string;
  /** Stable identity so an adapter can deduplicate its own retries. */
  readonly idempotencyKey: string;
}

export interface SendAcknowledgement {
  /**
   * Adapter accepted the send attempt. NOTIFICATIONS.md §6: this is not delivery.
   */
  readonly accepted: boolean;
  /** Opaque provider reference when one exists. */
  readonly providerReference?: string;
  readonly failureReason?: string;
  /**
   * `false` when a retry cannot help or could send twice (a permanent refusal, an
   * ambiguous acknowledgement): the send settles UNDELIVERABLE now. Absent means retryable.
   */
  readonly retryable?: boolean;
}

/**
 * Runtime mode on a port. `resend` and `gmail_smtp` are adapter identities. `resend`
 * is D-004's provider; `gmail_smtp` replaces it on v1 STAGING (suas-specs #75 R11.2).
 */
export type ChannelRuntimeMode = CommunicationMode | 'internal' | 'resend' | 'gmail_smtp';

export interface NotificationChannelPort {
  readonly channel: NotificationChannel;
  readonly mode: ChannelRuntimeMode;
  readonly implementation: string;
  send(message: OutboundMessage): Promise<SendAcknowledgement>;
}

export interface RecordedMessage extends OutboundMessage {
  readonly sentAt: Date;
}

/**
 * Fake or sink channel for the environment classes that forbid real external
 * effects. `fake` retains messages for inspection; `sink` accepts and discards.
 * Neither reaches a provider.
 */
export class RecordingChannel implements NotificationChannelPort {
  readonly implementation = 'recording-fake';

  private readonly messages: RecordedMessage[] = [];

  constructor(
    readonly channel: NotificationChannel,
    readonly mode: ChannelRuntimeMode,
  ) {}

  send(message: OutboundMessage): Promise<SendAcknowledgement> {
    if (this.mode === 'disabled') {
      return Promise.reject(new ChannelUnavailableError(this.channel));
    }
    if (this.mode === 'fake') {
      this.messages.push({ ...message, sentAt: new Date() });
    }
    return Promise.resolve({
      accepted: true,
      providerReference: `fake-${message.idempotencyKey}`,
    });
  }

  /** Test-only inspection. */
  sent(): readonly RecordedMessage[] {
    return this.messages;
  }

  lastFor(destination: string): RecordedMessage | undefined {
    return [...this.messages].reverse().find((message) => message.destination === destination);
  }

  clear(): void {
    this.messages.length = 0;
  }
}

/**
 * IN_APP delivery. The Notification row is the inbox entry and the client renders its
 * text, so acknowledging is the whole send and nothing is retained in memory.
 */
export class InternalChannel implements NotificationChannelPort {
  readonly channel = 'IN_APP' as const;
  readonly mode = 'internal' as const;
  readonly implementation = 'internal';

  send(): Promise<SendAcknowledgement> {
    return Promise.resolve({ accepted: true });
  }
}

/** Content-free email outcome log (implementation, accepted, outcome); NOTIFICATIONS.md §5, §10. */
function logEmailSend(record: ResendEmailLogRecord | GmailSmtpEmailLogRecord): void {
  console.log(JSON.stringify({ msg: 'email_send', ...record }));
}

/** A channel that always fails, for exercising retry and exhaustion paths. */
export class FailingChannel implements NotificationChannelPort {
  readonly implementation = 'failing-fake';
  readonly mode: CommunicationMode | 'internal' = 'fake';

  constructor(
    readonly channel: NotificationChannel,
    private readonly reason = 'provider unavailable',
  ) {}

  send(): Promise<SendAcknowledgement> {
    return Promise.resolve({ accepted: false, failureReason: this.reason });
  }
}

/**
 * Channels available for this configuration.
 *
 * EMAIL and SMS follow their released mode variables; a `disabled` mode yields no
 * port at all, so the caller reports the channel unavailable instead of faking a
 * send. IN_APP is internal and always present.
 *
 * D-004 selects Resend as the external EMAIL provider; R11.2 (proposal) replaces it
 * with `gmail_smtp` on v1 STAGING. Fake and sink stay recording-only; `resend` and
 * `gmail_smtp` construct their adapters with validated configuration. `gmail_smtp`
 * sends through the relay function when one is configured, else directly.
 */
export function createChannelRegistry(
  config: SuasConfig,
): Map<NotificationChannel, NotificationChannelPort> {
  const registry = new Map<NotificationChannel, NotificationChannelPort>();

  if (config.notifications.email === 'resend') {
    registry.set(
      'EMAIL',
      createResendEmailChannel({
        apiKey: config.notifications.resendApiKey,
        fromAddress: config.notifications.emailFrom,
        logger: logEmailSend,
      }),
    );
  } else if (config.notifications.email === 'gmail_smtp') {
    registry.set(
      'EMAIL',
      createGmailSmtpEmailChannel({
        user: config.notifications.smtp.user,
        appPassword: config.notifications.smtp.appPassword,
        relayFunction: config.notifications.smtp.relayFunction,
        region: config.aws.region,
        fixtureMailbox: config.stagingFixtureMailbox,
        logger: logEmailSend,
      }),
    );
  } else if (config.notifications.email !== 'disabled') {
    registry.set('EMAIL', new RecordingChannel('EMAIL', config.notifications.email));
  }
  if (config.notifications.sms !== 'disabled') {
    registry.set('SMS', new RecordingChannel('SMS', config.notifications.sms));
  }
  registry.set('IN_APP', new InternalChannel());

  return registry;
}
