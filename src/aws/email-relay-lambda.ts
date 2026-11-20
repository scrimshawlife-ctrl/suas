/**
 * Email relay function (suas #305). The staging VPC has no internet egress, so this function
 * runs outside it, with no database access, and is the only code that reaches Resend. The API
 * and job worker invoke it with one rendered message and get back the channel's acknowledgement.
 *
 * It alone reads the Resend key, from one Secrets Manager secret holding JSON
 * `{"RESEND_API_KEY": "..."}` named by `SUAS_EMAIL_SECRET_ID`, cached per container; the
 * sender is `SUAS_EMAIL_FROM`. It never logs the key, the recipient, the message or Resend's
 * replies, and it never throws for a send outcome: a thrown error reads as ambiguous.
 */

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import type { NotificationChannelPort } from '../notifications/channels.js';
import {
  emailRelayRequestSchema,
  fromRelayRequest,
  toRelayResponse,
  type EmailRelayResponse,
} from '../notifications/email-relay.js';
import { createResendEmailChannel, type FetchTransport } from '../notifications/resend-email.js';
import {
  stagingRecipientAllowed,
  type RecipientAllowed,
} from '../notifications/staging-recipients.js';

const secretSchema = z.object({ RESEND_API_KEY: z.string().min(1) });

/** Test seams. Production reads the secret and calls Resend over HTTPS. */
export interface EmailRelayDeps {
  readonly readSecret: () => Promise<string | undefined>;
  readonly fromAddress: string | undefined;
  /**
   * The STAGING last-hop allowlist, checked again here (r263 F2, #306). The relay reads its own
   * SUAS_PUBLIC_DEMO (R16.1, proposal), so an API in demo mode cannot open it alone.
   */
  readonly allowRecipient: RecipientAllowed;
  readonly transport?: FetchTransport;
}

function defaultDeps(): EmailRelayDeps {
  const secretId = process.env.SUAS_EMAIL_SECRET_ID;
  const mailbox = process.env.SUAS_STAGING_FIXTURE_MAILBOX?.trim().toLowerCase();
  const client = new SecretsManagerClient({});
  return {
    allowRecipient: stagingRecipientAllowed(
      mailbox === '' ? undefined : mailbox,
      process.env.SUAS_PUBLIC_DEMO === 'enabled',
    ),
    fromAddress: process.env.SUAS_EMAIL_FROM,
    readSecret: async () => {
      if (secretId === undefined || secretId === '') return undefined;
      const output = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
      return output.SecretString;
    },
  };
}

/** Builds a handler with its own per-container key cache. */
export function createEmailRelayHandler(
  deps: EmailRelayDeps = defaultDeps(),
): (event: unknown) => Promise<EmailRelayResponse> {
  let channel: NotificationChannelPort | undefined;

  const loadChannel = async (): Promise<NotificationChannelPort | undefined> => {
    if (channel !== undefined) return channel;
    try {
      const raw = await deps.readSecret();
      const parsed = secretSchema.safeParse(raw === undefined ? undefined : JSON.parse(raw));
      if (!parsed.success) return undefined;
      channel = createResendEmailChannel({
        apiKey: parsed.data.RESEND_API_KEY,
        fromAddress: deps.fromAddress,
        allowRecipient: deps.allowRecipient,
        ...(deps.transport !== undefined ? { transport: deps.transport } : {}),
      });
      return channel;
    } catch {
      return undefined;
    }
  };

  return async (event) => {
    // A malformed request cannot become sendable by retrying it.
    const request = emailRelayRequestSchema.safeParse(event);
    if (!request.success) {
      return { accepted: false, retryable: false, failure_reason: 'invalid_message' };
    }
    // An address off the STAGING allowlist is refused for good, before the secret is read.
    if (!deps.allowRecipient(request.data.to)) {
      return { accepted: false, retryable: false, failure_reason: 'recipient_not_allowed' };
    }
    // Nothing was sent without a key; storing the real one makes a later attempt work.
    const current = await loadChannel();
    if (current === undefined) return { accepted: false, failure_reason: 'relay_not_configured' };
    const ack = await current.send(fromRelayRequest(request.data));
    // A refusal may mean the key was rotated: read the secret again next time.
    if (!ack.accepted) channel = undefined;
    return toRelayResponse(ack);
  };
}

export const handler = createEmailRelayHandler();
