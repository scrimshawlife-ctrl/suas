/**
 * The send claim must outlast every provider call it fences (NOTIFICATIONS.md §3, §5). A
 * runner renews its claim just before the call and calls only within PRE_CALL_BUDGET_MS of
 * that, so the claim has to cover that budget, the longest bounded provider call and the
 * settle. If a provider timeout grows past
 * PROVIDER_CALL_MAX_MS, a second runner could retake the claim mid-call and send twice; this
 * pins the values so they cannot drift apart.
 */

import type { InvokeCommand, InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { describe, expect, it } from 'vitest';
import {
  LambdaRelayEmailChannel,
  RELAY_INVOKE_TIMEOUT_MS,
} from '../../src/notifications/lambda-relay-sender.js';
import {
  PRE_CALL_BUDGET_MS,
  PROVIDER_CALL_MAX_MS,
  SETTLE_MARGIN_MS,
} from '../../src/notifications/service.js';
import { stagingRecipientAllowed } from '../../src/notifications/staging-recipients.js';
import { OUTBOUND_FETCH_TIMEOUT_MS } from '../../src/resilience/index.js';

describe('send claim window', () => {
  it('bounds every provider call below the provider allowance', () => {
    // Resend direct (fetchWithTimeout) and the relay invoke are the only network providers;
    // SMS is recording-only and IN_APP is internal.
    expect(OUTBOUND_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(PROVIDER_CALL_MAX_MS);
    expect(RELAY_INVOKE_TIMEOUT_MS).toBeLessThanOrEqual(PROVIDER_CALL_MAX_MS);
  });

  it('leaves a usable pre-call budget after the provider call and the settle', () => {
    // The settle opens a pooled connection (connectionTimeoutMillis 10 s, src/db/pool.ts).
    expect(SETTLE_MARGIN_MS).toBeGreaterThanOrEqual(10_000);
    // The claim, re-check and render take milliseconds; a budget under 1 s would skip sends.
    expect(PRE_CALL_BUDGET_MS).toBeGreaterThanOrEqual(1_000);
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
