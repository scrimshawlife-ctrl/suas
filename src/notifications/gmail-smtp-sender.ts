/**
 * Gmail SMTP sender (suas-specs #75 R11.2, proposal): one message per connection to
 * `smtp.gmail.com:465` over implicit TLS, authenticated with a Google app password.
 *
 * The SMTP session is driven step by step (connect, login, send) so the result class
 * knows whether message data had started: a failure before that is retryable, a
 * failure after it without a final reply is an ambiguous acknowledgement
 * (NOTIFICATIONS.md §5). Nothing here logs: the password, recipient, server replies and
 * message body stay out of every log (NOTIFICATIONS.md §10).
 */

import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import type { SmtpMessage, SmtpSender, SmtpSendResult } from './smtp.js';

export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 465;

/** Implementation-owned bounds (ARCHITECTURE.md §13), not a released SLO. */
export const SMTP_TIMEOUTS = {
  connectionMs: 10_000,
  greetingMs: 10_000,
  socketMs: 15_000,
  /** The whole session, so a slow trickle of replies cannot outlast the relay function. */
  totalMs: 20_000,
} as const;

/** The SMTP error fields this module reads. Everything else stays inside the adapter. */
export interface SmtpErrorLike {
  readonly code?: string | undefined;
  readonly responseCode?: number | undefined;
}

/** The part of nodemailer's SMTPConnection this sender drives; tests supply a fake. */
export interface SmtpConnectionLike {
  connect(callback: (error?: SmtpErrorLike) => void): void;
  login(
    auth: { user: string; pass: string },
    callback: (error: SmtpErrorLike | null) => void,
  ): void;
  send(
    envelope: { from: string; to: string[] },
    message: Readable,
    callback: (error: SmtpErrorLike | null, info: { response?: string | undefined }) => void,
  ): void;
  quit(): void;
  close(): void;
  on(event: 'error', listener: (error: SmtpErrorLike) => void): unknown;
}

export type SmtpConnectionFactory = () => SmtpConnectionLike;

function defaultConnection(): SmtpConnectionLike {
  return new SMTPConnection({
    host: GMAIL_SMTP_HOST,
    port: GMAIL_SMTP_PORT,
    secure: true,
    connectionTimeout: SMTP_TIMEOUTS.connectionMs,
    greetingTimeout: SMTP_TIMEOUTS.greetingMs,
    socketTimeout: SMTP_TIMEOUTS.socketMs,
    logger: false,
  });
}

/** Envelope or content problems nodemailer reports before talking to the server. */
const LOCAL_MESSAGE_ERRORS: ReadonlySet<string> = new Set(['EENVELOPE', 'EMESSAGE']);

/**
 * R11.2 status mapping for a failure during the send step. Failures while connecting or
 * logging in never reach here: they are always retryable, because nothing was sent.
 */
export function classifySmtpSendFailure(
  error: SmtpErrorLike,
  dataStarted: boolean,
): SmtpSendResult {
  const code = error.responseCode;
  if (typeof code === 'number' && code >= 500) return { result: 'rejected', responseCode: code };
  if (typeof code === 'number' && code >= 400) return { result: 'retryable', responseCode: code };
  if (dataStarted) return { result: 'ambiguous_ack' };
  if (error.code !== undefined && LOCAL_MESSAGE_ERRORS.has(error.code)) {
    return { result: 'rejected' };
  }
  return { result: 'retryable' };
}

function replyCode(response: string | undefined): number | undefined {
  const match = /^(\d{3})/.exec(response ?? '');
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

function senderDomain(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

/** Builds the MIME message. From is always the authenticated Gmail account (R11.2). */
async function composeMessage(from: string, message: SmtpMessage): Promise<Buffer> {
  return new MailComposer({
    from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html !== undefined ? { html: message.html } : {}),
    messageId: `<${message.messageId}@${senderDomain(from)}>`,
    xMailer: false,
  })
    .compile()
    .build();
}

export interface GmailSmtpSenderOptions {
  readonly user: string;
  readonly appPassword: string;
  /** Test seam. Defaults to a TLS connection to smtp.gmail.com:465. */
  readonly connect?: SmtpConnectionFactory;
  readonly totalTimeoutMs?: number;
}

export class GmailSmtpSender implements SmtpSender {
  readonly implementation = 'gmail_smtp';

  private readonly user: string;
  private readonly appPassword: string;
  private readonly connect: SmtpConnectionFactory;
  private readonly totalTimeoutMs: number;

  constructor(options: GmailSmtpSenderOptions) {
    this.user = options.user;
    this.appPassword = options.appPassword;
    this.connect = options.connect ?? defaultConnection;
    this.totalTimeoutMs = options.totalTimeoutMs ?? SMTP_TIMEOUTS.totalMs;
  }

  async send(message: SmtpMessage): Promise<SmtpSendResult> {
    let raw: Buffer;
    try {
      raw = await composeMessage(this.user, message);
    } catch {
      return { result: 'rejected' };
    }
    return this.deliver(message.to, raw);
  }

  private deliver(to: string, raw: Buffer): Promise<SmtpSendResult> {
    return new Promise((resolve) => {
      const connection = this.connect();
      let sending = false;
      let dataStarted = false;
      let settled = false;

      const finish = (result: SmtpSendResult, close: 'quit' | 'close'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        try {
          if (close === 'quit') connection.quit();
          else connection.close();
        } catch {
          // The result is already decided; a failing close changes nothing.
        }
        resolve(result);
      };
      const fail = (error: SmtpErrorLike): void => {
        const result: SmtpSendResult = sending
          ? classifySmtpSendFailure(error, dataStarted)
          : { result: 'retryable' };
        finish(result, 'close');
      };

      const deadline = setTimeout(() => fail({ code: 'ETIMEDOUT' }), this.totalTimeoutMs);
      // SMTPConnection emits 'error' as well as calling back; an unheard 'error' would throw.
      connection.on('error', fail);

      // The message stream is read only after the server answered DATA with 354, so the
      // first read marks the point after which a lost reply is ambiguous.
      const body = new Readable({
        read() {
          dataStarted = true;
          this.push(raw);
          this.push(null);
        },
      });

      connection.connect((connectError) => {
        if (connectError !== undefined && connectError !== null) return fail(connectError);
        connection.login({ user: this.user, pass: this.appPassword }, (loginError) => {
          if (loginError !== null && loginError !== undefined) return fail(loginError);
          sending = true;
          connection.send({ from: this.user, to: [to] }, body, (sendError, info) => {
            if (sendError !== null && sendError !== undefined) return fail(sendError);
            // nodemailer calls back without an error only on a 2xx final reply (250).
            const code = replyCode(info.response);
            finish(
              { result: 'sent', ...(code !== undefined ? { responseCode: code } : {}) },
              'quit',
            );
          });
        });
      });
    });
  }
}
