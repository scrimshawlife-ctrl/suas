/**
 * Amazon SES adapter for the EMAIL capability port.
 *
 * Spec and plan citations:
 * - SUAS-specs ARCHITECTURE.md §11 (`EmailPort`; vendor payloads stay adapter-local)
 * - SUAS-specs ARCHITECTURE.md §13 (finite outbound timeout)
 * - SUAS-specs NOTIFICATIONS.md §6 (`accepted` is not delivered), §10 (no message
 *   bodies or credentials in ordinary logs), §11 (provider statuses stay out of
 *   product contracts)
 * - V1_PROJECT_PLAN.md §2.2, §4.1 (Amazon SES replaces Resend)
 *
 * SES v2 `SendEmail` has no idempotency key, so a retry after an ambiguous
 * timeout can send twice. Deduplication stays with the notification service's
 * own dedupe key and send-attempt records, not with this adapter.
 * Credentials come from the AWS default provider chain (the Lambda role), never
 * from SUAS configuration.
 */

import { SendEmailCommand, SESv2Client, type SendEmailCommandOutput } from '@aws-sdk/client-sesv2';
import { isAwsTimeout } from '../aws/errors.js';
import { OUTBOUND_FETCH_TIMEOUT_MS } from '../resilience/outbound-fetch.js';
import type { NotificationChannelPort, OutboundMessage, SendAcknowledgement } from './channels.js';

export const SES_IMPLEMENTATION = 'ses' as const;

export type SesSendOutcome = 'accepted' | 'not_accepted' | 'timeout';

/** Structured send log. Never includes addresses, subjects, or bodies. */
export interface SesEmailLogRecord {
  readonly implementation: typeof SES_IMPLEMENTATION;
  readonly channel: 'EMAIL';
  readonly accepted: boolean;
  readonly outcome: SesSendOutcome;
}

export type SesEmailLogger = (record: SesEmailLogRecord) => void;

/** The one SES client method this adapter uses; tests supply a fake. */
export interface SesClientLike {
  send(
    command: SendEmailCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<SendEmailCommandOutput>;
}

export class SesEmailMisconfiguredError extends Error {
  readonly code = 'CONFIGURATION_INVALID';

  constructor(detail: string) {
    super(
      `SES EmailPort is misconfigured: ${detail}. ` +
        `ENVIRONMENT.md §5 requires configuration for an enabled capability.`,
    );
    this.name = 'SesEmailMisconfiguredError';
  }
}

function requireConfigured(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === '') {
    throw new SesEmailMisconfiguredError(`${label} is absent`);
  }
  return value;
}

export interface SesEmailChannelOptions {
  readonly region: string | undefined;
  readonly fromAddress: string | undefined;
  /** Test seam. Defaults to a real SES client for `region`. */
  readonly client?: SesClientLike;
  readonly logger?: SesEmailLogger;
}

/** Fail closed unless region and from address are present. */
export function createSesEmailChannel(options: SesEmailChannelOptions): SesEmailChannel {
  const region = requireConfigured(options.region, 'SUAS_AWS_REGION');
  const fromAddress = requireConfigured(options.fromAddress, 'SUAS_EMAIL_FROM');
  return new SesEmailChannel({
    fromAddress,
    client: options.client ?? new SESv2Client({ region }),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/**
 * SES EMAIL port. `accepted` means SES accepted the send request and returned
 * a MessageId; it does not mean the message was delivered (NOTIFICATIONS.md §6).
 */
export class SesEmailChannel implements NotificationChannelPort {
  readonly channel = 'EMAIL' as const;
  readonly mode = SES_IMPLEMENTATION;
  readonly implementation = SES_IMPLEMENTATION;

  private readonly fromAddress: string;
  private readonly client: SesClientLike;
  private readonly logger: SesEmailLogger | undefined;

  constructor(options: {
    readonly fromAddress: string;
    readonly client: SesClientLike;
    readonly logger?: SesEmailLogger;
  }) {
    this.fromAddress = options.fromAddress;
    this.client = options.client;
    this.logger = options.logger;
  }

  async send(message: OutboundMessage): Promise<SendAcknowledgement> {
    if (
      message.channel !== 'EMAIL' ||
      message.subject === undefined ||
      message.subject.trim() === '' ||
      message.html === undefined ||
      message.html.trim() === ''
    ) {
      return this.finish('not_accepted');
    }

    try {
      const output = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromAddress,
          Destination: { ToAddresses: [message.destination] },
          Content: {
            Simple: {
              Subject: { Data: message.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: message.body, Charset: 'UTF-8' },
                Html: { Data: message.html, Charset: 'UTF-8' },
              },
            },
          },
        }),
        { abortSignal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS) },
      );

      const providerReference = output.MessageId;
      if (providerReference === undefined || providerReference === '') {
        return this.finish('not_accepted');
      }
      this.emit('accepted');
      return { accepted: true, providerReference };
    } catch (error: unknown) {
      return this.finish(isAwsTimeout(error) ? 'timeout' : 'not_accepted');
    }
  }

  private finish(outcome: Exclude<SesSendOutcome, 'accepted'>): SendAcknowledgement {
    this.emit(outcome);
    return { accepted: false, failureReason: outcome };
  }

  private emit(outcome: SesSendOutcome): void {
    this.logger?.({
      implementation: SES_IMPLEMENTATION,
      channel: 'EMAIL',
      accepted: outcome === 'accepted',
      outcome,
    });
  }
}
