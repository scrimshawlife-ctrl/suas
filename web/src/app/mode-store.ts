import { useSyncExternalStore } from 'react';
import type { Mode } from '../components/ModeSwitch';

/**
 * The last chosen mode ("Need support" or "Serve"), kept in sessionStorage. Routes that
 * are shared between modes (chat, notifications, crisis) read it to pick their chrome.
 */
const KEY = 'suas.mode';
let memory: Mode = 'support';
const listeners = new Set<() => void>();

function read(): Mode {
  try {
    return window.sessionStorage.getItem(KEY) === 'serve' ? 'serve' : 'support';
  } catch {
    // Storage blocked: fall back to the in-memory value.
    return memory;
  }
}

export function getMode(): Mode {
  return read();
}

export function setMode(mode: Mode): void {
  if (read() === mode) return;
  memory = mode;
  try {
    window.sessionStorage.setItem(KEY, mode);
  } catch {
    // Storage blocked: the in-memory value still applies for this tab.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useMode(): Mode {
  return useSyncExternalStore(subscribe, getMode);
}
