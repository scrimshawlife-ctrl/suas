/**
 * Connection push capability port: send one payload to one open connection.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.2 (Chat: API Gateway WebSocket API),
 * §4.3 F7. AGENTS.md rule 6: the SDK stays in the adapter. Messages themselves are
 * stored and listed over REST, so a push is a best-effort hint that something new
 * exists; callers must treat failure as non-fatal.
 */

/**
 * `delivered`: the provider accepted the payload.
 * `gone`: the connection no longer exists, so the caller removes it from its registry.
 */
export type PushOutcome = 'delivered' | 'gone';

/** `unavailable`: provider error or no access. `timeout`: no answer in time. */
export type PushFailureKind = 'unavailable' | 'timeout';

export class ConnectionPushError extends Error {
  constructor(readonly kind: PushFailureKind) {
    super(`Connection push ${kind}`);
    this.name = 'ConnectionPushError';
  }
}

export interface ConnectionPushPort {
  readonly implementation: string;
  /** The WebSocket URL a client opens (the ticket is appended by the caller). */
  connectUrl(): string;
  /** Throws {@link ConnectionPushError} when the outcome is neither delivered nor gone. */
  send(connectionId: string, payload: string): Promise<PushOutcome>;
}
