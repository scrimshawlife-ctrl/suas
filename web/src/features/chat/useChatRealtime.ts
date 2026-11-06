import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSessionToken } from '../../api/token-store';
import { applyMessageToCaches, CHAT_KEY_ROOT, issueConnectTicket } from './api';
import { ChatRealtime, type RealtimeStatus } from './realtime';

/** How often chat refetches over REST while there is no live socket to rely on. */
export const POLL_INTERVAL_MS = 10_000;
/** Safety-net refetch while the socket reads `live`, in case it is half-open. */
export const LIVE_POLL_INTERVAL_MS = 60_000;
/** A tab hidden this long may hold a socket the network already dropped. */
export const STALE_AFTER_HIDDEN_MS = 30_000;

/**
 * Whether coming back to the tab (or the network) should restart the socket now: always when
 * it is reconnecting or the network returned, and when the tab was hidden long enough that a
 * `live` socket may be half-open.
 */
export function shouldRestart(input: {
  status: RealtimeStatus;
  hiddenForMs: number;
  networkBack: boolean;
}): boolean {
  return (
    input.networkBack ||
    input.status === 'reconnecting' ||
    input.hiddenForMs > STALE_AFTER_HIDDEN_MS
  );
}

/**
 * Opens the chat WebSocket while the chat screen is mounted and a session exists, merges
 * pushed messages into the query caches, and refetches over REST: every 10 s while there is
 * no live socket (push unavailable, reconnecting), every 60 s while live, and when the tab
 * regains focus. Returning to the tab, or the network coming back, restarts a reconnecting
 * or long-hidden socket at once. Closes the socket on unmount and when the session token
 * goes away (sign-out).
 */
export function useChatRealtime(): RealtimeStatus {
  const token = useSessionToken();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<RealtimeStatus>('connecting');

  useEffect(() => {
    if (token === null) return;
    let current: RealtimeStatus = 'connecting';
    let hiddenAt: number | null = null;
    const realtime = new ChatRealtime({
      fetchTicket: issueConnectTicket,
      createSocket: (url) => new WebSocket(url),
      onMessage: (message) => {
        // The server pushes a message only to the other participant.
        applyMessageToCaches(queryClient, message, false);
      },
      onStatus: (next) => {
        current = next;
        setStatus(next);
      },
      onResync: () => {
        void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
      },
    });

    const comeBack = (networkBack: boolean) => {
      if (document.visibilityState === 'hidden') return;
      const hiddenForMs = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
      if (shouldRestart({ status: current, hiddenForMs, networkBack })) realtime.restart();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenAt ??= Date.now();
      else comeBack(false);
    };
    const onFocus = () => {
      comeBack(false);
    };
    const onOnline = () => {
      comeBack(true);
    };

    realtime.start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      realtime.stop();
    };
  }, [token, queryClient]);

  const fast = status === 'polling' || status === 'reconnecting';
  useEffect(() => {
    if (token === null) return;
    const id = setInterval(
      () => {
        if (document.visibilityState === 'hidden') return;
        void queryClient.invalidateQueries({ queryKey: CHAT_KEY_ROOT });
      },
      fast ? POLL_INTERVAL_MS : LIVE_POLL_INTERVAL_MS,
    );
    return () => {
      clearInterval(id);
    };
  }, [fast, token, queryClient]);

  return status;
}
