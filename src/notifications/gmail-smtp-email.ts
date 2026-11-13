/**
 * Gmail SMTP adapter for the EMAIL capability port (suas-specs #75 R11.2, proposal;
 * supersedes D-004 "Resend only" and R4.12 SES for v1 STAGING; not released).
 *
 * Status mapping (R11.2, NOTIFICATIONS.md §5, §6):
 * - SMTP 250 is accepted (`SENT`). Gmail gives no delivery callback, so `DELIVERED` and
 *   `BOUNCED` are never reached.
 * - A permanent 5xx refusal and an ambiguous acknowledgement are not retryable: the send
 *   settles `UNDELIVERABLE` with the reason in its audit. A 4xx or a failure before any
 *   message data is retryable.
 */

import type { NotificationChannelPort, OutboundMessage, SendAcknowledgement } from './channels.js';
import { GmailSmtpSender } from './gmail-smtp-sender.js';
import { LambdaRelaySmtpSender } from './lambda-relay-sender.js';
import { smtpMessageId, type SmtpResultClass, type SmtpSender } from './smtp.js';

export const GMAIL_SMTP_IMPLEMENTATION = 'gmail_smtp' as const;

/** Reasons recorded on the attempt audit. Provider-neutral words only (NOTIFICATIONS.md §11). */
export const GMAIL_SMTP_FAILURE_REASONS = {
  rejected: 'smtp_rejected',
  retryable: 'smtp_retryable_failure',
  ambiguous_ack: 'smtp_ambiguous_ack',
  invalid_message: 'invalid_message',
} as const;

/** Structured send log. Never includes addresses, subjects, bodies or server replies. */
export interface GmailSmtpEmailLogRecord {
  readonly implementation: typeof GMAIL_SMTP_IMPLEMENTATION;
  readonly channel: 'EMAIL';
  readonly accepted: boolean;
  readonly outcome: SmtpResultClass | 'invalid_message';
  readonly response_code?: number;
}

export type GmailSmtpEmailLogger = (record: GmailSmtpEmailLogRecord) => void;

export class GmailSmtpEmailMisconfiguredError extends Error {
  readonly code = 'CONFIGURATION_INVALID';

  constructor(detail: string) {
    super(
      `Gmail SMTP EmailPort is misconfigured: ${detail}. ` +
        `ENVIRONMENT.md §5 requires configuration for an enabled capability.`,
    );
    this.name = 'GmailSmtpEmailMisconfiguredError';
  }
}

export interface GmailSmtpEmailChannelOptions {
  readonly user: string | undefined;
  readonly appPassword: string | undefined;
  /** When set, the outside-VPC relay function sends; it alone holds the app password. */
  readonly relayFunction: string | undefined;
  readonly region: string | undefined;
  readonly logger?: GmailSmtpEmailLogger;
}

function present(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== '';
}

/** Fail closed: the relay needs its name and region, a direct send needs user and password. */
export function createGmailSmtpEmailChannel(
  options: GmailSmtpEmailChannelOptions,
): GmailSmtpEmailChannel {
  let sender: SmtpSender;
  if (present(options.relayFunction)) {
    if (!present(options.region))
      throw new GmailSmtpEmailMisconfiguredError('SUAS_AWS_REGION is absent');
    sender = new LambdaRelaySmtpSender({
      functionName: options.relayFunction,
      region: options.region,
    });
  } else {
    if (!present(options.user))
      throw new GmailSmtpEmailMisconfiguredError('SUAS_SMTP_USER is absent');
    if (!present(options.appPassword)) {
      throw new GmailSmtpEmailMisconfiguredError('SUAS_SMTP_APP_PASSWORD is absent');
    }
    sender = new GmailSmtpSender({ user: options.user, appPassword: options.appPassword });
  }
  return new GmailSmtpEmailChannel(sender, options.logger);
}

export class GmailSmtpEmailChannel implements NotificationChannelPort {
  readonly channel = 'EMAIL' as const;
  readonly mode = GMAIL_SMTP_IMPLEMENTATION;
  readonly implementation = GMAIL_SMTP_IMPLEMENTATION;

  constructor(
    private readonly sender: SmtpSender,
    private readonly logger?: GmailSmtpEmailLogger,
  ) {}

  async send(message: OutboundMessage): Promise<SendAcknowledgement> {
    if (
      message.channel !== 'EMAIL' ||
      message.subject === undefined ||
      message.subject.trim() === '' ||
      message.body.trim() === ''
    ) {
      this.emit('invalid_message');
      return {
        accepted: false,
        retryable: false,
        failureReason: GMAIL_SMTP_FAILURE_REASONS.invalid_message,
      };
    }

    const messageId = smtpMessageId(message.idempotencyKey);
    const sent = await this.sender.send({
      to: message.destination,
      subject: message.subject,
      text: message.body,
      ...(message.html !== undefined ? { html: message.html } : {}),
      messageId,
    });
    this.emit(sent.result, sent.responseCode);

    if (sent.result === 'sent') return { accepted: true, providerReference: messageId };
    return {
      accepted: false,
      retryable: sent.result === 'retryable',
      failureReason: GMAIL_SMTP_FAILURE_REASONS[sent.result],
    };
  }

  private emit(outcome: GmailSmtpEmailLogRecord['outcome'], responseCode?: number): void {
    this.logger?.({
      implementation: GMAIL_SMTP_IMPLEMENTATION,
      channel: 'EMAIL',
      accepted: outcome === 'sent',
      outcome,
      ...(responseCode !== undefined ? { response_code: responseCode } : {}),
    });
  }
}
