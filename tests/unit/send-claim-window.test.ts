/**
 * The send claim must outlast every provider call it fences (NOTIFICATIONS.md §3, §5). The
 * claim is renewed just before the call, so it has to cover the longest bounded provider call
 * plus the settle; if a provider timeout grows past that, a second runner could retake the
 * claim mid-call and send twice. This pins the invariant so the values cannot drift apart.
 */

import type { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import {
  LambdaRelayEmailChannel,
  RELAY_INVOKE_TIMEOUT_MS,
} from '../../src/notifications/lambda-relay-sender.js';
import { SEND_CLAIM_MS } from '../../src/notifications/service.js';
import { stagingRecipientAllowed } from '../../src/notifications/staging-recipients.js';
import { OUTBOUND_FETCH_TIMEOUT_MS } from '../../src/resilience/index.js';

// The settle opens a pooled connection (pg connectionTimeoutMillis, src/db/pool.ts) before
// its claim-guarded update, so the claim keeps at least that much after the provider call.
const SETTLE_MARGIN_MS = 10_000;

describe('send claim window', () => {
  it('outlasts the longest provider call plus the settle', () => {
    // Resend direct (fetchWithTimeout) and the relay invoke are the only network providers;
    // SMS is recording-only and IN_APP is internal.
    const longestProviderCall = Math.max(OUTBOUND_FETCH_TIMEOUT_MS, RELAY_INVOKE_TIMEOUT_MS);
    expect(SEND_CLAIM_MS).toBeGreaterThanOrEqual(longestProviderCall + SETTLE_MARGIN_MS);
  });

  it('bounds the relay invoke with an abort signal', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const client = {
      send(_command: InvokeCommand, options?: { abortSignal?: AbortSignal }) {
        signals.push(options?.abortSignal);
        return Promise.resolve<InvokeCommandOutput>({
          $metadata: {},
          StatusCode: 200,
          Payload: new TextEncoder().encode(
            JSON.stringify({ accepted: true, provider_reference: 'resend-id' }),
          ) as NonNullable<InvokeCommandOutput['Payload']>,
        });
      },
    };
    const channel = new LambdaRelayEmailChannel({
      functionName: 'relay',
      region: 'us-west-2',
      client,
      allowRecipient: stagingRecipientAllowed(undefined),
    });

    await channel.send({
      channel: 'EMAIL',
      destination: 'recipient@example.invalid',
      templateVersion: 'invite@1',
      subject: 'Subject line',
      body: 'Body text',
      html: '<p>Body text</p>',
      idempotencyKey: 'invite:1',
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(false);
  });
});
