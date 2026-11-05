/**
 * Amazon API Gateway WebSocket adapter for the connection push port.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.2 and §4.3 F7. PostToConnection answers
 * HTTP 410 (GoneException) for a connection that has closed. Region comes from
 * configuration and credentials from the AWS default provider chain; the Lambda role
 * needs execute-api:ManageConnections on the API (infrastructure, not this file).
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  type PostToConnectionCommandOutput,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { awsErrorName, awsHttpStatus, isAwsTimeout } from '../aws/errors.js';
import { OUTBOUND_FETCH_TIMEOUT_MS } from '../resilience/outbound-fetch.js';
import {
  ConnectionPushError,
  type ConnectionPushPort,
  type PushOutcome,
} from './connection-push.js';

export const APIGW_PUSH_IMPLEMENTATION = 'apigw-management' as const;

/** The one client method this adapter uses; tests supply a fake. */
export interface ApiGatewayManagementClientLike {
  send(
    command: PostToConnectionCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PostToConnectionCommandOutput>;
}

export interface ApiGatewayConnectionPushOptions {
  /** `https://{api-id}.execute-api.{region}.amazonaws.com/{stage}` */
  readonly endpoint: string;
  readonly region: string;
  /** `wss://` URL clients open instead of the management endpoint's host (custom domain). */
  readonly publicUrl?: string;
  readonly client?: ApiGatewayManagementClientLike;
}

export class ApiGatewayConnectionPush implements ConnectionPushPort {
  readonly implementation = APIGW_PUSH_IMPLEMENTATION;

  private readonly endpoint: string;
  private readonly publicUrl: string | undefined;
  private readonly client: ApiGatewayManagementClientLike;

  constructor(options: ApiGatewayConnectionPushOptions) {
    this.endpoint = options.endpoint;
    this.publicUrl = options.publicUrl;
    this.client =
      options.client ??
      new ApiGatewayManagementApiClient({ region: options.region, endpoint: options.endpoint });
  }

  /**
   * The configured public URL, else the management endpoint with `wss:`, which shares
   * its host and stage. The management calls always use `endpoint`.
   */
  connectUrl(): string {
    if (this.publicUrl !== undefined) return this.publicUrl;
    return this.endpoint.replace(/^https:/i, 'wss:');
  }

  async send(connectionId: string, payload: string): Promise<PushOutcome> {
    try {
      await this.client.send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: new TextEncoder().encode(payload),
        }),
        { abortSignal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS) },
      );
      return 'delivered';
    } catch (error: unknown) {
      if (awsHttpStatus(error) === 410 || awsErrorName(error) === 'GoneException') return 'gone';
      throw new ConnectionPushError(isAwsTimeout(error) ? 'timeout' : 'unavailable');
    }
  }
}
