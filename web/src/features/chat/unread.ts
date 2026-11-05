import { useSyncExternalStore } from 'react';
import { useChatThreads } from '../../api/chat';
import type { ChatThread } from '../../api/types';

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
  markSeen: (serviceRequestId: string, atMs: number) => void;
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
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const seenStore: SeenStore = createSeenStore();

export function countUnread(threads: readonly ChatThread[], state: SeenState): number {
  return threads.filter((thread) => {
    if (thread.last_message_at === null) return false;
    const last = Date.parse(thread.last_message_at);
    return last > (state.seen[thread.service_request_id] ?? state.baseline);
  }).length;
}

/**
 * Number of conversations with a message newer than the last one the person opened or sent.
 * Counts from the thread list, which refreshes while the chat screen is open and on the
 * query's own refetch; it does not hold a socket of its own. A message sent from another
 * device shows as unread here, because the thread list does not say who sent the last one.
 */
export function useChatUnreadCount(): number {
  const threads = useChatThreads();
  const state = useSyncExternalStore(seenStore.subscribe, seenStore.getState);
  return countUnread(threads.data?.threads ?? [], state);
}
