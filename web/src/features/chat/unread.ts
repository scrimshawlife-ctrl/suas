import { useInfiniteQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { chatThreadsQueryOptions } from '../../api/chat';
import { tokenStore, useSessionToken } from '../../api/token-store';
import type { ChatThread } from '../../api/types';
import { allThreads, threadKey } from './threads';

/**
 * Which conversations the person has read, kept per browser tab in sessionStorage.
 * `baseline` is when this tab first looked; a thread with no entry counts as unread only if
 * its last message is newer than that, so a fresh tab does not flag every old thread.
 * Times are milliseconds from the server's own `created_at` / `last_message_at`.
 */
export interface SeenState {
  baseline: number;
  seen: Record<string, number>;
}

const STORAGE_KEY = 'suas.chat.seen';

export interface SeenStore {
  getState: () => SeenState;
  markSeen: (threadKey: string, atMs: number) => void;
  /** Starts over with a new baseline (sign-out: the next person has read nothing). */
  reset: () => void;
  subscribe: (listener: () => void) => () => void;
}

function load(): SeenState {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const parsed = JSON.parse(raw) as Partial<SeenState>;
      if (typeof parsed.baseline === 'number' && typeof parsed.seen === 'object') {
        return { baseline: parsed.baseline, seen: parsed.seen };
      }
    }
  } catch {
    // Storage blocked or unreadable: start fresh.
  }
  return { baseline: Date.now(), seen: {} };
}

export function createSeenStore(): SeenStore {
  let state = load();
  const listeners = new Set<() => void>();
  const persist = () => {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The in-memory copy keeps this tab working.
    }
  };
  persist();
  return {
    getState: () => state,
    markSeen(id, atMs) {
      if (atMs <= (state.seen[id] ?? 0)) return;
      state = { ...state, seen: { ...state.seen, [id]: atMs } };
      persist();
      listeners.forEach((listener) => {
        listener();
      });
    },
    reset() {
      state = { baseline: Date.now(), seen: {} };
      persist();
      listeners.forEach((listener) => {
        listener();
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const seenStore: SeenStore = createSeenStore();

// Sign-out (or an expired session) drops the token: the next person has read nothing.
tokenStore.subscribe(() => {
  if (tokenStore.getToken() === null) seenStore.reset();
});

export function countUnread(threads: readonly ChatThread[], state: SeenState): number {
  return threads.filter((thread) => {
    if (thread.last_message_at === null || thread.last_message_from_me === true) return false;
    const last = Date.parse(thread.last_message_at);
    return last > (state.seen[threadKey(thread)] ?? state.baseline);
  }).length;
}

/** Unread numbers stay fresh on any screen: refetch about every minute while the tab is visible. */
export const UNREAD_REFETCH_MS = 60_000;

/**
 * Number of conversations with a message newer than the last one the person opened or sent,
 * for the header badge: `import { useChatUnreadCount } from '../features/chat/unread'`.
 * It reads the thread list through its own observer that refetches every minute (TanStack
 * skips interval refetches while the tab is hidden); the chat screen's live socket keeps the
 * same list current while it is open. A thread whose newest message is the person's own
 * (`last_message_from_me`) does not count, including one sent from another device.
 */
export function useChatUnreadCount(): number {
  const token = useSessionToken();
  const threads = useInfiniteQuery({
    ...chatThreadsQueryOptions(),
    enabled: token !== null,
    refetchInterval: UNREAD_REFETCH_MS,
  });
  const state = useSyncExternalStore(seenStore.subscribe, seenStore.getState);
  return countUnread(allThreads(threads.data) ?? [], state);
}
