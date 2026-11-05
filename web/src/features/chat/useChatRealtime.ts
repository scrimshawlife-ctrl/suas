import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSessionToken } from '../../api/token-store';
import { applyMessageToCaches, CHAT_KEY_ROOT, issueConnectTicket } from './api';
import { ChatRealtime, type RealtimeStatus } from './realtime';

/** How often chat refetches over REST while live updates are unavailable. */
export const POLL_INTERVAL_MS = 10_000;

/**
 * Opens the chat WebSocket while the chat screen is mounted and a session exists, merges
 * pushed messages into the query caches, and falls back to polling every 10 s while there
 * is no live socket to rely on (push unavailable, or reconnecting), and refetches when the
 * tab regains focus. Closes the socket on unmount and when the session token goes away
 * (sign-out).
 */
export function useChatRealtime(): RealtimeStatus {
  const token = useSessionToken();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    if (token === null) return;
    const realtime = new ChatRealtime({
      fetchTicket: issueConnectTicket,
      createSocket: (url) => new WebSocket(url),
      onMessage: (message) => {
        applyMessageToCaches(queryClient, message);
      },
      onStatus: setStatus,
      onResync: () => {
        void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
      },
    });
    realtime.start();
    return () => {
      realtime.stop();
    };
  }, [token, queryClient]);

  // Coming back to the tab refetches, because a socket may have slept and a session may have expired.
  useEffect(() => {
    if (token === null) return;
    const refetch = () => {
      if (document.visibilityState === 'hidden') return;
      void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
    };
    window.addEventListener('focus', refetch);
    document.addEventListener('visibilitychange', refetch);
    return () => {
      window.removeEventListener('focus', refetch);
      document.removeEventListener('visibilitychange', refetch);
    };
  }, [token, queryClient]);

  const polling = status === 'polling' || status === 'reconnecting';
  useEffect(() => {
    if (!polling || token === null) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, [polling, token, queryClient]);

  return status;
}
