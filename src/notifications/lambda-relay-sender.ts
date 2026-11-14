/**
 * SMTP sender that hands one rendered message to the outside-VPC relay function
 * (suas-specs #75 R11.2, proposal). The staging VPC has no internet egress, so the API
 * and job worker reach Gmail only through this Lambda Invoke; the relay alone holds the
 * app password.
 *
 * Classification of a failed invoke: if the relay may have run (a timeout waiting for
 * its answer, or the function itself erroring), the message may already be out, so the
 * result is an ambiguous acknowledgement. Only a known pre-execution rejection is
 * retryable. SDK retries are off: the job outbox owns retrying.
 */

import { InvokeCommand, LambdaClient, type InvokeCommandOutput } from '@aws-sdk/client-lambda';
import { awsErrorName } from '../aws/errors.js';
import {
  smtpRelayResponseSchema,
  toRelayRequest,
  type SmtpMessage,
  type SmtpSender,
  type SmtpSendResult,
} from './smtp.js';

// These Invoke rejections occur before the function executes; transport loss is unknown.
const INVOKE_REJECTIONS: ReadonlySet<string> = new Set([
  'TooManyRequestsException',
  'AccessDeniedException',
  'ResourceNotFoundException',
  'InvalidParameterValueException',
  'InvalidRequestContentException',
  'RequestTooLargeException',
  'UnsupportedMediaTypeException',
]);

/** Above the relay's own SMTP session bound, so the relay answers first. */
export const RELAY_INVOKE_TIMEOUT_MS = 28_000;

/** The one Lambda client method this sender uses; tests supply a fake. */
export interface LambdaClientLike {
  send(
    command: InvokeCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<InvokeCommandOutput>;
}

export interface LambdaRelaySenderOptions {
  readonly functionName: string;
  readonly region: string;
  readonly client?: LambdaClientLike;
}

export class LambdaRelaySmtpSender implements SmtpSender {
  readonly implementation = 'gmail_smtp_relay';

  private readonly functionName: string;
  private readonly client: LambdaClientLike;

  constructor(options: LambdaRelaySenderOptions) {
    this.functionName = options.functionName;
    this.client = options.client ?? new LambdaClient({ region: options.region, maxAttempts: 1 });
  }

  async send(message: SmtpMessage): Promise<SmtpSendResult> {
    let output: InvokeCommandOutput;
    try {
      output = await this.client.send(
        new InvokeCommand({
          FunctionName: this.functionName,
          InvocationType: 'RequestResponse',
          Payload: new TextEncoder().encode(JSON.stringify(toRelayRequest(message))),
        }),
        { abortSignal: AbortSignal.timeout(RELAY_INVOKE_TIMEOUT_MS) },
      );
    } catch (error: unknown) {
      const name = awsErrorName(error);
      return {
        result: name !== undefined && INVOKE_REJECTIONS.has(name) ? 'retryable' : 'ambiguous_ack',
      };
    }

    // A function error (crash or relay timeout) can happen after the SMTP data went out.
    if (output.FunctionError !== undefined || output.Payload === undefined) {
      return { result: 'ambiguous_ack' };
    }
    const parsed = smtpRelayResponseSchema.safeParse(parsePayload(output.Payload));
    if (!parsed.success) return { result: 'ambiguous_ack' };
    return {
      result: parsed.data.result,
      ...(parsed.data.response_code !== undefined
        ? { responseCode: parsed.data.response_code }
        : {}),
    };
  }
}

function parsePayload(payload: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return undefined;
  }
}
