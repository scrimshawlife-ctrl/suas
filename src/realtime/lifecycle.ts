/**
 * What a WebSocket transport asks of the application when a connection opens or
 * closes. The AWS Lambda entry and the local WebSocket server both call it, so the
 * connect-time authentication lives in one place (the ticket redeemed in
 * `src/chat/connect-tickets.ts`).
 */

export interface ConnectionLifecycle {
  /** `refused` for a missing, unknown, expired or already used ticket. */
  connect(input: {
    readonly connectionId: string;
    readonly ticket: string | undefined;
  }): Promise<'accepted' | 'refused'>;
  /** Idempotent: closing an unregistered connection is a no-op. */
  disconnect(connectionId: string): Promise<void>;
}
