import type { SuasConfig } from '../config/index.js';
import { ApiGatewayConnectionPush } from './apigw-connection-push.js';
import type { ConnectionPushPort } from './connection-push.js';
import type { ConnectionLifecycle } from './lifecycle.js';
import { LocalWebSocketPush } from './local-websocket-push.js';

export {
  APIGW_PUSH_IMPLEMENTATION,
  ApiGatewayConnectionPush,
  type ApiGatewayConnectionPushOptions,
  type ApiGatewayManagementClientLike,
} from './apigw-connection-push.js';
export {
  ConnectionPushError,
  type ConnectionPushPort,
  type PushFailureKind,
  type PushOutcome,
} from './connection-push.js';
export type { ConnectionLifecycle } from './lifecycle.js';
export { LOCAL_WEBSOCKET_IMPLEMENTATION, LocalWebSocketPush } from './local-websocket-push.js';

/**
 * Push port for this configuration, or undefined when disabled so callers report
 * live updates unavailable. Config validation guarantees `apigw` has a region and
 * endpoint and that `local` is used only in LOCAL/TEST. A `local` port still has
 * to be started with `listen()`.
 */
export function createConnectionPushPort(
  config: SuasConfig,
  lifecycle: ConnectionLifecycle,
): ConnectionPushPort | undefined {
  const { mode, apiGatewayEndpoint } = config.chatPush;
  if (mode === 'local') return new LocalWebSocketPush(lifecycle);
  if (mode === 'apigw' && apiGatewayEndpoint !== undefined && config.aws.region !== undefined) {
    return new ApiGatewayConnectionPush({
      endpoint: apiGatewayEndpoint,
      region: config.aws.region,
    });
  }
  return undefined;
}
