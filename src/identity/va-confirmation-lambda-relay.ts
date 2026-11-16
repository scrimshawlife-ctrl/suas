/**
 * VA confirmation from inside the STAGING VPC (VA_CONFIRMATION_FLOW W9 item 4, R9.2 option (b),
 * released in 0.10.0). The API has no internet route, so it hands one projection to the
 * outside-VPC verify function by Lambda Invoke; that function alone holds the sandbox key and
 * base URL, and answers with only the normalized result and failure class.
 *
 * A failed invoke is always UNAVAILABLE with a D035 §11 failure class, never a more definite
 * answer. A VA query is read-like, so unlike the email relay there is no ambiguous outcome.
 * SDK retries are off: a retry is a new attempt (W5 item 3).
 */

import { InvokeCommand, LambdaClient, type InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { awsErrorName, awsHttpStatus, isAwsTimeout } from '../aws/errors.js';
import {
  latencyBucket,
  VaConfirmationMisconfiguredError,
  type VaConfirmationLogger,
} from './va-confirmation-http.js';
import {
  VA_CONFIRMATION_CONTRACT_VERSION,
  VA_CONFIRMATION_PROJECTION_ID,
  type VaConfirmationFailureClass,
  type VaConfirmationProjection,
  type VeteranConfirmationPort,
  type VeteranConfirmationResult,
} from './va-confirmation.js';
import {
  fromVaVerifyResponse,
  vaVerifyRequestSchema,
  vaVerifyResponseSchema,
} from './va-verify-relay.js';

export const VA_CONFIRMATION_RELAY_IMPLEMENTATION = 'va-confirmation-lambda-relay' as const;

/** Above the verify function's own 15 s timeout, so it answers first. */
export const VA_VERIFY_INVOKE_TIMEOUT_MS = 18_000;

// Invoke rejections that mean this deployment is wrong (no grant, no function, a bad request
// shape), not that VA or the path to it is down. They are not outages (W6 item 7).
const CONFIGURATION_REJECTIONS: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'ResourceNotFoundException',
  'InvalidParameterValueException',
  'InvalidRequestContentException',
  'RequestTooLargeException',
  'UnsupportedMediaTypeException',
]);

/** The one Lambda client method this adapter uses; tests supply a fake. */
export interface LambdaInvokeClient {
  send(
    command: InvokeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeCommandOutput>;
}

export interface VaConfirmationLambdaRelayOptions {
  readonly functionName: string;
  readonly region: string | undefined;
  readonly client?: LambdaInvokeClient;
  readonly logger?: VaConfirmationLogger;
}

/** Fails closed before any invoke when the function or region is absent. */
export function createVaConfirmationLambdaRelay(
  options: VaConfirmationLambdaRelayOptions,
): VaConfirmationLambdaRelay {
  const { region } = options;
  if (region === undefined || region.trim() === '') {
    throw new VaConfirmationMisconfiguredError('SUAS_AWS_REGION is absent');
  }
  return new VaConfirmationLambdaRelay(options.functionName, {
    ...options,
    client: options.client ?? new LambdaClient({ region, maxAttempts: 1 }),
  });
}

export class VaConfirmationLambdaRelay implements VeteranConfirmationPort {
  readonly implementation = VA_CONFIRMATION_RELAY_IMPLEMENTATION;
  readonly providerEnvironment = 'SANDBOX' as const;

  constructor(
    private readonly functionName: string,
    private readonly options: {
      readonly client: LambdaInvokeClient;
      logger?: VaConfirmationLogger;
    },
  ) {}

  async confirm(projection: VaConfirmationProjection): Promise<VeteranConfirmationResult> {
    const started = Date.now();
    const result = await this.invoke(projection);
    this.options.logger?.({
      adapter: VA_CONFIRMATION_RELAY_IMPLEMENTATION,
      adapter_version: VA_CONFIRMATION_CONTRACT_VERSION,
      provider_environment: this.providerEnvironment,
      projection_id: VA_CONFIRMATION_PROJECTION_ID,
      normalized_status: result.status,
      failure_class: result.failureClass ?? null,
      latency_bucket: latencyBucket(Date.now() - started),
    });
    return result;
  }

  private async invoke(projection: VaConfirmationProjection): Promise<VeteranConfirmationResult> {
    const request = vaVerifyRequestSchema.safeParse(projection);
    if (!request.success) return unavailable('REQUEST_INVALID');

    let output: InvokeCommandOutput;
    try {
      output = await this.options.client.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: 'RequestResponse',
          Payload: new TextEncoder().encode(JSON.stringify(request.data)),
        }),
        { abortSignal: AbortSignal.timeout(VA_VERIFY_INVOKE_TIMEOUT_MS) },
      );
    } catch (error: unknown) {
      return unavailable(invokeFailureClass(error));
    }

    // The function never throws for a VA outcome, so an error here is a crash or its timeout
    // (PROVIDER_UNAVAILABLE: R14.5 proposal).
    if (output.FunctionError !== undefined) return unavailable('PROVIDER_UNAVAILABLE');
    const parsed = vaVerifyResponseSchema.safeParse(parsePayload(output.Payload));
    return parsed.success
      ? fromVaVerifyResponse(parsed.data)
      : unavailable('PROVIDER_RESPONSE_INVALID');
  }
}

/**
 * D035 §11 classes for an invoke that did not return: our own deployment fault is
 * CONFIGURATION_INVALID, a timeout is TIMEOUT, a lost connection is NETWORK_ERROR. A Lambda
 * throttle (PROVIDER_RATE_LIMITED) and a Lambda 5xx (PROVIDER_UNAVAILABLE) are R14.5 proposal.
 */
export function invokeFailureClass(error: unknown): VaConfirmationFailureClass {
  const name = awsErrorName(error);
  if (name !== undefined && CONFIGURATION_REJECTIONS.has(name)) return 'CONFIGURATION_INVALID';
  if (name === 'TooManyRequestsException') return 'PROVIDER_RATE_LIMITED';
  if (isAwsTimeout(error)) return 'TIMEOUT';
  return awsHttpStatus(error) !== undefined ? 'PROVIDER_UNAVAILABLE' : 'NETWORK_ERROR';
}

function unavailable(failureClass: VaConfirmationFailureClass): VeteranConfirmationResult {
  return { status: 'UNAVAILABLE', failureClass };
}

function parsePayload(payload: Uint8Array | undefined): unknown {
  if (payload === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
}
