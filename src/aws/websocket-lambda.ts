/**
 * Lambda handler export for the API Gateway WebSocket API routes. Reads the process
 * environment (like src/main.ts) and delegates to `handleWebSocketEvent`.
 */

import { ConfigurationError, loadConfig } from '../config/index.js';
import { createPool } from '../db/index.js';
import { createChatConnectionLifecycle } from '../chat/index.js';
import type { ConnectionLifecycle } from '../realtime/lifecycle.js';
import {
  handleWebSocketEvent,
  type WebSocketLambdaEvent,
  type WebSocketLambdaResult,
} from './websocket-handler.js';

let cachedLifecycle: ConnectionLifecycle | undefined;

function lifecycleFromEnvironment(): ConnectionLifecycle {
  if (cachedLifecycle !== undefined) return cachedLifecycle;
  const config = loadConfig(process.env);
  if (config.chatPush.mode !== 'apigw') {
    throw new ConfigurationError([
      'SUAS_CHAT_PUSH_MODE=apigw is required for the WebSocket Lambda.',
    ]);
  }
  cachedLifecycle = createChatConnectionLifecycle(createPool(config, 'node'));
  return cachedLifecycle;
}

export function handler(event: WebSocketLambdaEvent): Promise<WebSocketLambdaResult> {
  return handleWebSocketEvent(event, lifecycleFromEnvironment());
}
