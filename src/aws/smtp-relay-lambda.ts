/**
 * SMTP relay function (suas-specs #75 R11.2, proposal; not released).
 *
 * The staging VPC has no internet egress, so this function runs outside it, with no
 * database access, and is the only code that reaches smtp.gmail.com. The API and job
 * worker invoke it with one rendered message and get back the SMTP result class.
 *
 * It alone reads the Gmail credentials, from one Secrets Manager secret holding JSON
 * `{"SUAS_SMTP_USER": "...", "SUAS_SMTP_APP_PASSWORD": "..."}` named by
 * `SUAS_SMTP_SECRET_ID`, cached per container. It never logs the credentials, the
 * recipient, the message or the server's replies, and it never throws for an SMTP
 * outcome: a thrown error reads as an ambiguous acknowledgement to the caller.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { GmailSmtpSender } from '../notifications/gmail-smtp-sender.js';
import {
  fromRelayRequest,
  smtpRelayRequestSchema,
  toRelayResponse,
  type SmtpRelayResponse,
  type SmtpSender,
} from '../notifications/smtp.js';

const credentialsSchema = z.object({
  SUAS_SMTP_USER: z.string().email(),
  SUAS_SMTP_APP_PASSWORD: z.string().min(1),
});
type Credentials = z.infer<typeof credentialsSchema>;

/** Test seams. Production reads the secret and sends through Gmail. */
export interface SmtpRelayDeps {
  readonly readSecret: () => Promise<string | undefined>;
  readonly createSender: (credentials: Credentials) => SmtpSender;
}

function defaultDeps(): SmtpRelayDeps {
  const secretId = process.env.SUAS_SMTP_SECRET_ID;
  const client = new SecretsManagerClient({});
  return {
    readSecret: async () => {
      if (secretId === undefined || secretId === '') return undefined;
      const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      return output.SecretString;
    },
    createSender: (credentials) =>
      new GmailSmtpSender({
        user: credentials.SUAS_SMTP_USER,
        appPassword: credentials.SUAS_SMTP_APP_PASSWORD,
      }),
  };
}

/** Builds a handler with its own per-container credential cache. */
export function createSmtpRelayHandler(
  deps: SmtpRelayDeps = defaultDeps(),
): (event: unknown) => Promise<SmtpRelayResponse> {
  let sender: SmtpSender | undefined;

  const loadSender = async (): Promise<SmtpSender | undefined> => {
    if (sender !== undefined) return sender;
    try {
      const raw = await deps.readSecret();
      const parsed = credentialsSchema.safeParse(raw === undefined ? undefined : JSON.parse(raw));
      if (!parsed.success) return undefined;
      sender = deps.createSender(parsed.data);
      return sender;
    } catch {
      return undefined;
    }
  };

  return async (event) => {
    // A malformed request cannot become sendable by retrying it.
    const request = smtpRelayRequestSchema.safeParse(event);
    if (!request.success) return { result: 'rejected' };
    // Nothing was sent without credentials; a fixed secret makes a later attempt work.
    const current = await loadSender();
    if (current === undefined) return { result: 'retryable' };
    const result = await current.send(fromRelayRequest(request.data));
    // A login refusal may mean the app password was rotated: read the secret again next time.
    if (result.result === 'retryable') sender = undefined;
    return toRelayResponse(result);
  };
}

export const handler = createSmtpRelayHandler();
