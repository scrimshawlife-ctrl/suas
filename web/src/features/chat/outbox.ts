import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import { tokenStore } from '../../api/token-store';
import { applyMessageToCaches, postChatMessage } from './api';
import { isFinalSendError, sendRefusedText } from './copy';
import type { ChatMessage } from './messages';

export interface PendingMessage {
  clientId: string;
  /** One Idempotency-Key per send; "Try again" reuses it so the server never stores twice. */
  key: string;
  body: string;
  /** `failed` can be sent again ("Not sent."); `refused` cannot ("Could not send."). */
  status: 'sending' | 'failed' | 'refused';
  /** Why a `refused` send cannot go, in plain words. */
  reason?: string;
}

// A send with no answer is given up by the API client's request timeout ("Not sent."),
// so later messages in the chat still go.
type SendFn = (id: string, body: string, key: string) => Promise<ChatMessage>;

const NONE: readonly PendingMessage[] = [];

export interface Outbox {
  get: (serviceRequestId: string) => readonly PendingMessage[];
  send: (queryClient: QueryClient, serviceRequestId: string, body: string) => void;
  retry: (queryClient: QueryClient, serviceRequestId: string, clientId: string) => void;
  /** Forgets everything and ignores sends still in flight (sign-out). */
  clear: () => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * Messages the person has sent that the server has not confirmed, per conversation. They live
 * outside any component so a send that fails after the person left the conversation still
 * shows "Not sent." when they come back. A message leaves the list once the stored message
 * is merged into the cache; `clear` drops all of it on sign-out.
 */
export function createOutbox(send: SendFn = postChatMessage): Outbox {
  let byRequest = new Map<string, readonly PendingMessage[]>();
  // The tail of each conversation's send chain: one POST in flight at a time, so the server
  // stores messages in the order they were typed (it orders by arrival).
  let queues = new Map<string, Promise<void>>();
  let epoch = 0;
  const listeners = new Set<() => void>();
  const emit = () => {
    listeners.forEach((listener) => {
      listener();
    });
  };
  const update = (
    id: string,
    change: (list: readonly PendingMessage[]) => readonly PendingMessage[],
  ) => {
    const next = change(byRequest.get(id) ?? NONE);
    byRequest = new Map(byRequest).set(id, next);
    emit();
  };

  const attempt = async (queryClient: QueryClient, id: string, item: PendingMessage) => {
    const startedIn = epoch;
    try {
      const sent = await send(id, item.body, item.key);
      if (startedIn !== epoch) return;
      applyMessageToCaches(queryClient, sent, true);
      update(id, (list) => list.filter((p) => p.clientId !== item.clientId));
    } catch (error) {
      if (startedIn !== epoch) return;
      const failed: Partial<PendingMessage> = isFinalSendError(error)
        ? { status: 'refused', reason: sendRefusedText(error) }
        : { status: 'failed' };
      update(id, (list) =>
        list.map((p) => (p.clientId === item.clientId ? { ...p, ...failed } : p)),
      );
    }
  };
  const enqueue = (queryClient: QueryClient, id: string, item: PendingMessage) => {
    const queuedIn = epoch;
    const tail = (queues.get(id) ?? Promise.resolve()).then(() =>
      queuedIn === epoch ? attempt(queryClient, id, item) : undefined,
    );
    queues.set(id, tail);
  };

  return {
    get: (id) => byRequest.get(id) ?? NONE,
    send(queryClient, id, body) {
      const item: PendingMessage = {
        clientId: crypto.randomUUID(),
        key: crypto.randomUUID(),
        body,
        status: 'sending',
      };
      update(id, (list) => [...list, item]);
      enqueue(queryClient, id, item);
    },
    retry(queryClient, id, clientId) {
      const item = (byRequest.get(id) ?? NONE).find((p) => p.clientId === clientId);
      if (item?.status !== 'failed') return;
      const again: PendingMessage = { ...item, status: 'sending' };
      update(id, (list) => list.map((p) => (p.clientId === clientId ? again : p)));
      enqueue(queryClient, id, again);
    },
    clear() {
      epoch += 1;
      byRequest = new Map();
      queues = new Map();
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const outbox: Outbox = createOutbox();

// Sign-out (or an expired session) drops the token: forget what the last person sent.
tokenStore.subscribe(() => {
  if (tokenStore.getToken() === null) outbox.clear();
});

export function useOutbox(serviceRequestId: string) {
  const queryClient = useQueryClient();
  const pending = useSyncExternalStore(outbox.subscribe, () => outbox.get(serviceRequestId));
  const send = useCallback(
    (body: string) => {
      outbox.send(queryClient, serviceRequestId, body);
    },
    [queryClient, serviceRequestId],
  );
  const retry = useCallback(
    (clientId: string) => {
      outbox.retry(queryClient, serviceRequestId, clientId);
    },
    [queryClient, serviceRequestId],
  );
  return { pending, send, retry };
}
