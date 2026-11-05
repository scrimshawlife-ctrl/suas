import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { applyMessageToCaches, postChatMessage } from './api';

export interface PendingMessage {
  clientId: string;
  /** One Idempotency-Key per send; "Try again" reuses it so the server never stores twice. */
  key: string;
  body: string;
  status: 'sending' | 'failed';
}

/**
 * Messages the person has sent that the server has not confirmed. They show at the end of
 * the conversation (optimistic), turn to `failed` on an error, and leave the list once the
 * stored message is merged into the cache.
 */
export function useOutbox(serviceRequestId: string) {
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<PendingMessage[]>([]);

  const attempt = useCallback(
    async (item: PendingMessage) => {
      try {
        const sent = await postChatMessage(serviceRequestId, item.body, item.key);
        applyMessageToCaches(queryClient, sent);
        setPending((all) => all.filter((p) => p.clientId !== item.clientId));
      } catch {
        setPending((all) =>
          all.map((p) => (p.clientId === item.clientId ? { ...p, status: 'failed' } : p)),
        );
      }
    },
    [serviceRequestId, queryClient],
  );

  const send = useCallback(
    (body: string) => {
      const item: PendingMessage = {
        clientId: crypto.randomUUID(),
        key: crypto.randomUUID(),
        body,
        status: 'sending',
      };
      setPending((all) => [...all, item]);
      void attempt(item);
    },
    [attempt],
  );

  const retry = useCallback(
    (clientId: string) => {
      const item = pending.find((p) => p.clientId === clientId);
      if (item === undefined || item.status === 'sending') return;
      setPending((all) =>
        all.map((p) => (p.clientId === clientId ? { ...p, status: 'sending' } : p)),
      );
      void attempt(item);
    },
    [pending, attempt],
  );

  return { pending, send, retry };
}
