/**
 * Resend adapter for the EMAIL capability port.
 *
 * Spec citations:
 * - SUAS-specs ARCHITECTURE.md §11 (`EmailPort`; vendor payloads stay adapter-local)
 * - SUAS-specs ARCHITECTURE.md §13 (finite outbound timeout)
 * - SUAS-specs NOTIFICATIONS.md §2 (do not fake delivery), §6 (`accepted` is not
 *   delivered), §10 (no message bodies or credentials in ordinary logs), §11
 *   (provider statuses must not leak into product contracts)
 * - SUAS-specs ENVIRONMENT.md §3 (released `SUAS_EMAIL_MODE` stays
 *   `disabled|fake|sink`; this adapter is not a selectable mode), §5
 *   (required secrets fail closed when this adapter is constructed), §6
 *   (email provider credentials are secrets)
 * - SUAS-specs AUTH.md §9 (challenge delivery uses this same EMAIL port)
 *
 * Official send API: HTTPS POST https://api.resend.com/emails
 * `createChannelRegistry` does not construct this class. ENVIRONMENT.md §3 has
 * not released a `resend` email mode.
 */

import { fetchWithTimeout } from '../resilience/outbound-fetch.js';
import type { NotificationChannelPort, OutboundMessage, SendAcknowledgement } from './channels.js';

export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const RESEND_IDEMPOTENCY_KEY_MAX_LENGTH = 256;
export const RESEND_IMPLEMENTATION = 'resend' as const;

export type ResendSendOutcome = 'accepted' | 'not_accepted' | 'timeout';

/** Structured send log. Never includes Authorization, API keys, or bodies. */
export interface ResendEmailLogRecord {
  readonly implementation: typeof RESEND_IMPLEMENTATION;
  readonly channel: 'EMAIL';
  readonly accepted: boolean;
  readonly outcome: ResendSendOutcome;
}

export type ResendEmailLogger = (record: ResendEmailLogRecord) => void;

export interface FetchTransport {
  fetch(url: string, init: RequestInit): Promise<Response>;
}

const defaultTransport: FetchTransport = {
  fetch(url, init) {
    return fetchWithTimeout(url, init);
  },
};

export interface ResendEmailChannelOptions {
  readonly apiKey: string;
  readonly fromAddress: string;
  readonly transport?: FetchTransport;
  readonly logger?: ResendEmailLogger;
}

export class ResendEmailMisconfiguredError extends Error {
  readonly code = 'CONFIGURATION_INVALID';

  constructor(detail: string) {
    super(
      `Resend EmailPort is misconfigured: ${detail}. ` +
        `ENVIRONMENT.md §5 requires secrets for an enabled capability.`,
    );
    this.name = 'ResendEmailMisconfiguredError';
  }
}

/**
 * Fail closed unless both the API key and from address are present.
 * Callers must not construct this adapter from `createChannelRegistry`.
 */
export function createResendEmailChannel(options: {
  readonly apiKey: string | undefined;
  readonly fromAddress: string | undefined;
  readonly transport?: FetchTransport;
  readonly logger?: ResendEmailLogger;
}): ResendEmailChannel {
  if (options.apiKey === undefined) {
    throw new ResendEmailMisconfiguredError('RESEND_API_KEY is absent');
  }
  if (options.fromAddress === undefined) {
    throw new ResendEmailMisconfiguredError('SUAS_EMAIL_FROM is absent');
  }
  return new ResendEmailChannel({
    apiKey: options.apiKey,
    fromAddress: options.fromAddress,
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
  });
}

/**
 * Resend EMAIL port. `accepted` means Resend accepted the send attempt.
 * It does not mean the message was delivered (NOTIFICATIONS.md §6).
 */
export class ResendEmailChannel implements NotificationChannelPort {
  readonly channel = 'EMAIL' as const;
  readonly mode = RESEND_IMPLEMENTATION;
  readonly implementation = RESEND_IMPLEMENTATION;

  private readonly apiKey: string;
  private readonly fromAddress: string;
  private readonly transport: FetchTransport;
  private readonly logger: ResendEmailLogger | undefined;

  constructor(options: ResendEmailChannelOptions) {
    this.apiKey = options.apiKey;
    this.fromAddress = options.fromAddress;
    this.transport = options.transport ?? defaultTransport;
    this.logger = options.logger;
  }

  async send(message: OutboundMessage): Promise<SendAcknowledgement> {
    if (message.channel !== 'EMAIL') {
      return this.finish('not_accepted');
    }
    if (
      message.idempotencyKey.length === 0 ||
      message.idempotencyKey.length > RESEND_IDEMPOTENCY_KEY_MAX_LENGTH
    ) {
      return this.finish('not_accepted');
    }
    if (message.subject === undefined || message.html === undefined) {
      return this.finish('not_accepted');
    }

    try {
      const response = await this.transport.fetch(RESEND_EMAILS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: this.fromAddress,
          to: [message.destination],
          subject: message.subject,
          text: message.body,
          html: message.html,
        }),
      });

      const payload: unknown = await readJsonBody(response);
      if (hasProviderError(payload) || !response.ok) {
        return this.finish('not_accepted');
      }

      const providerReference = providerId(payload);
      if (providerReference === undefined) {
        return this.finish('not_accepted');
      }

      this.emit('accepted');
      return { accepted: true, providerReference };
    } catch (error: unknown) {
      return this.finish(isTimeoutError(error) ? 'timeout' : 'not_accepted');
    }
  }

  private finish(outcome: Exclude<ResendSendOutcome, 'accepted'>): SendAcknowledgement {
    this.emit(outcome);
    return { accepted: false, failureReason: outcome };
  }

  private emit(outcome: ResendSendOutcome): void {
    this.logger?.({
      implementation: RESEND_IMPLEMENTATION,
      channel: 'EMAIL',
      accepted: outcome === 'accepted',
      outcome,
    });
  }
}

async function readJsonBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function hasProviderError(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const error = (payload as { error?: unknown }).error;
  return error !== undefined && error !== null;
}

function providerId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as { id?: unknown; data?: unknown };
  if (typeof record.id === 'string' && record.id.length > 0) return record.id;
  if (typeof record.data === 'object' && record.data !== null) {
    const id = (record.data as { id?: unknown }).id;
    if (typeof id === 'string' && id.length > 0) return id;
  }
  return undefined;
}

function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'TimeoutError' || name === 'AbortError';
}
