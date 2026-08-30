/**
 * Challenge delivery capability port.
 *
 * Spec citations:
 * - SUAS-specs AUTH.md §2 (passwordless methods; supported "where email/SMS
 *   provider configured"), §9 (provider-neutral delivery: "If a delivery provider
 *   is unavailable, that channel is unavailable. Do not fake success.")
 * - SUAS-specs ENVIRONMENT.md §3 "Notifications" (SUAS_EMAIL_MODE /
 *   SUAS_SMS_MODE = disabled|fake|sink; production external modes are not valid
 *   on the 0.2.0 pin)
 * - SUAS-specs ARCHITECTURE.md §11 (infrastructure ports: SmsPort, EmailPort)
 *
 * The rule that matters here: a disabled channel is reported unavailable rather
 * than silently succeeding. Faking delivery would tell a veteran a code is on its
 * way when nothing was sent.
 *
 * Challenge EMAIL/SMS uses the same notification channel port as product
 * notifications. There is no second Resend client. `createChallengeDelivery`
 * uses the Resend-backed EMAIL port when D-004's `resend` mode is selected.
 */

import type { CommunicationMode, SuasConfig } from '../config/index.js';
import type {
  NotificationChannel,
  NotificationChannelPort,
  OutboundMessage,
} from '../notifications/channels.js';
import { RESEND_IMPLEMENTATION } from '../notifications/resend-email.js';
import { renderEmailTemplate } from '../notifications/templates.js';

export type ChallengeMethod = 'MAGIC_LINK' | 'EMAIL_OTP' | 'PHONE_OTP';
export type ChallengeChannel = 'EMAIL' | 'SMS';

export const CHALLENGE_METHODS: readonly ChallengeMethod[] = [
  'MAGIC_LINK',
  'EMAIL_OTP',
  'PHONE_OTP',
];

export function channelForMethod(method: ChallengeMethod): ChallengeChannel {
  return method === 'PHONE_OTP' ? 'SMS' : 'EMAIL';
}

/**
 * AUTH.md §9. Raised when a channel has no configured delivery path. This is a
 * truthful unavailability, not a failure to try.
 */
export class ChannelUnavailableError extends Error {
  readonly code = 'CHANNEL_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor(channel: ChallengeChannel) {
    super(
      `The ${channel} channel is not available in this environment, so no challenge was sent. ` +
        `Delivery mode is "disabled" (SUAS-specs AUTH.md §9; ENVIRONMENT.md §3).`,
    );
    this.name = 'ChannelUnavailableError';
  }
}

export interface ChallengeDelivery {
  readonly channel: ChallengeChannel;
  readonly destination: string;
  readonly method: ChallengeMethod;
  /** The magic-link token or OTP code being delivered. */
  readonly secret: string;
  readonly expiresAt: Date;
  /** Stable send identity when the EMAIL/SMS port needs an idempotency key. */
  readonly idempotencyKey?: string;
}

export interface ChallengeDeliveryPort {
  /** Delivery mode actually in force, for operational truthfulness. */
  readonly mode: CommunicationMode;
  readonly implementation: string;
  availableChannels(): readonly ChallengeChannel[];
  deliver(delivery: ChallengeDelivery): Promise<void>;
}

export interface RecordedDelivery extends ChallengeDelivery {
  readonly deliveredAt: Date;
}

/**
 * Fake/sink delivery for the environment classes that forbid real external
 * effects. `fake` retains messages for inspection; `sink` accepts and discards,
 * matching the released mode names.
 */
export class RecordingChallengeDelivery implements ChallengeDeliveryPort {
  readonly implementation = 'recording-fake';

  private readonly deliveries: RecordedDelivery[] = [];

  constructor(
    readonly mode: CommunicationMode,
    private readonly channels: readonly ChallengeChannel[],
  ) {}

  availableChannels(): readonly ChallengeChannel[] {
    return this.channels;
  }

  deliver(delivery: ChallengeDelivery): Promise<void> {
    if (!this.channels.includes(delivery.channel)) {
      return Promise.reject(new ChannelUnavailableError(delivery.channel));
    }
    if (this.mode === 'fake') {
      this.deliveries.push({ ...delivery, deliveredAt: new Date() });
    }
    // `sink` accepts and drops; nothing leaves the process in either mode.
    return Promise.resolve();
  }

  /** Test-only inspection. Never call this from product code. */
  delivered(): readonly RecordedDelivery[] {
    return this.deliveries;
  }

  lastFor(destination: string): RecordedDelivery | undefined {
    return [...this.deliveries].reverse().find((item) => item.destination === destination);
  }

  clear(): void {
    this.deliveries.length = 0;
  }
}

/**
 * Which channels a configuration actually supports.
 * A mode of `disabled` yields no channel, so callers must report unavailability.
 */
export function availableChannels(config: SuasConfig): ChallengeChannel[] {
  const channels: ChallengeChannel[] = [];
  if (config.notifications.email !== 'disabled') channels.push('EMAIL');
  if (config.notifications.sms !== 'disabled') channels.push('SMS');
  return channels;
}

/**
 * Map a challenge onto the EMAIL/SMS notification port.
 * EMAIL uses the catalog renderer. SMS stays text-only. Do not log the secret
 * (NOTIFICATIONS.md §10).
 */
export function outboundMessageFromChallenge(delivery: ChallengeDelivery): OutboundMessage {
  const idempotencyKey =
    delivery.idempotencyKey ??
    `auth:${delivery.method}:${delivery.destination}:${delivery.expiresAt.toISOString()}`;
  const templateVersion = `auth.${delivery.method.toLowerCase()}`;

  if (delivery.channel === 'EMAIL') {
    const rendered = renderEmailTemplate(templateVersion, templateVersion, {
      secret: delivery.secret,
      expiresAt: delivery.expiresAt,
    });
    return {
      channel: 'EMAIL',
      destination: delivery.destination,
      templateVersion,
      subject: rendered.subject,
      body: rendered.text,
      html: rendered.html,
      idempotencyKey,
    };
  }

  return {
    channel: delivery.channel,
    destination: delivery.destination,
    templateVersion,
    body: delivery.secret,
    idempotencyKey,
  };
}

/**
 * AUTH.md §9. Raised when a configured adapter does not accept the send.
 * This is not success and does not fake delivery.
 */
export class ChallengeDeliveryFailedError extends Error {
  readonly code = 'DELIVERY_FAILED';
  readonly httpStatus = 503;

  constructor(channel: ChallengeChannel) {
    super(
      `The ${channel} challenge was not accepted by the delivery adapter ` +
        `(SUAS-specs AUTH.md §9).`,
    );
    this.name = 'ChallengeDeliveryFailedError';
  }
}

/**
 * Delivers challenges through the same EMAIL/SMS notification ports.
 * Use this when the EMAIL port is the Resend adapter so magic link and
 * EMAIL_OTP do not construct a second vendor client.
 */
export class ChannelBackedChallengeDelivery implements ChallengeDeliveryPort {
  readonly implementation: string;

  constructor(
    readonly mode: CommunicationMode,
    private readonly email: NotificationChannelPort | undefined,
    private readonly sms: NotificationChannelPort | undefined,
  ) {
    this.implementation = email?.implementation ?? sms?.implementation ?? 'none';
  }

  availableChannels(): readonly ChallengeChannel[] {
    const channels: ChallengeChannel[] = [];
    if (this.email !== undefined) channels.push('EMAIL');
    if (this.sms !== undefined) channels.push('SMS');
    return channels;
  }

  async deliver(delivery: ChallengeDelivery): Promise<void> {
    const port = delivery.channel === 'SMS' ? this.sms : this.email;
    if (port === undefined) {
      throw new ChannelUnavailableError(delivery.channel);
    }
    const acknowledgement = await port.send(outboundMessageFromChallenge(delivery));
    if (!acknowledgement.accepted) {
      throw new ChallengeDeliveryFailedError(delivery.channel);
    }
  }
}

function reportedDeliveryMode(
  config: SuasConfig,
  channels: readonly ChallengeChannel[],
): CommunicationMode {
  if (config.notifications.email === 'fake' || config.notifications.sms === 'fake') {
    return 'fake';
  }
  return channels.length === 0 ? 'disabled' : 'sink';
}

/**
 * Build the delivery port for this configuration.
 *
 * When a caller supplies an EMAIL port whose implementation is `resend`,
 * challenges use that same port.
 */
export function createChallengeDelivery(
  config: SuasConfig,
  channelPorts?: ReadonlyMap<NotificationChannel, NotificationChannelPort>,
): ChallengeDeliveryPort {
  const channels = availableChannels(config);
  const mode = reportedDeliveryMode(config, channels);
  const email = channelPorts?.get('EMAIL');
  const sms = channelPorts?.get('SMS');
  if (
    email?.implementation === RESEND_IMPLEMENTATION ||
    sms?.implementation === RESEND_IMPLEMENTATION
  ) {
    return new ChannelBackedChallengeDelivery(mode, email, sms);
  }
  return new RecordingChallengeDelivery(mode, channels);
}
