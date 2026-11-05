/**
 * AWS Lambda entry for the API Gateway WebSocket API routes.
 *
 * Plan citation: V1_PROJECT_PLAN.md §2.2 (Chat: API Gateway WebSocket API + Lambda),
 * §4.3 F7. Deploy this as its own Lambda function (handler `websocket-handler.handler`
 * from the same bundle as the API) and point the `$connect`, `$disconnect` and
 * `$default` routes at it. It is not served through the Lambda Web Adapter, which
 * fronts the HTTP server for HTTP API events.
 *
 * - `$connect` authenticates by redeeming the one-time ticket in `?ticket=` and
 *   registers the connection; any other outcome answers 401 and API Gateway refuses
 *   the upgrade.
 * - `$disconnect` drops the registry entry.
 * - `$default` accepts and ignores frames: messages are sent over REST, not here.
 *
 * Neither ticket nor connection id is logged.
 */

import type { ConnectionLifecycle } from '../realtime/lifecycle.js';

/** The parts of an API Gateway WebSocket proxy event this handler reads. */
export interface WebSocketLambdaEvent {
  readonly requestContext: {
    readonly routeKey: string;
    readonly connectionId: string;
  };
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
}

export interface WebSocketLambdaResult {
  readonly statusCode: number;
}

export async function handleWebSocketEvent(
  event: WebSocketLambdaEvent,
  lifecycle: ConnectionLifecycle,
): Promise<WebSocketLambdaResult> {
  const { routeKey, connectionId } = event.requestContext;
  switch (routeKey) {
    case '$connect': {
      const outcome = await lifecycle.connect({
        connectionId,
        ticket: event.queryStringParameters?.ticket,
      });
      return { statusCode: outcome === 'accepted' ? 200 : 401 };
    }
    case '$disconnect':
      await lifecycle.disconnect(connectionId);
      return { statusCode: 200 };
    default:
      return { statusCode: 200 };
  }
}
