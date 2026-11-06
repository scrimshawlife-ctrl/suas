import { useSyncExternalStore } from 'react';

/**
 * Session credential store. The Bearer token lives in sessionStorage (cleared when the tab
 * closes) and is mirrored in memory so a blocked or full storage degrades to "signed in
 * until reload" instead of throwing. `mfaElevated` records whether the last sign-in or
 * MFA step-up reported an elevated session; it only steers the admin route guard, the
 * server remains the authority.
 */
const TOKEN_KEY = 'suas.session';
const MFA_KEY = 'suas.mfa';

type Listener = () => void;

export interface TokenStore {
  getToken: () => string | null;
  setToken: (token: string, options?: { mfaElevated?: boolean }) => void;
  /** Drops the session (expiry, 401). Guards send the person to /sign-in and remember where they were. */
  clear: () => void;
  /** Drops the session because the person chose to sign out. Guards then go to "/", with no `from`. */
  signOut: () => void;
  /** True after `signOut` until the next sign-in. */
  isSignedOut: () => boolean;
  isMfaElevated: () => boolean;
  setMfaElevated: (value: boolean) => void;
  subscribe: (listener: Listener) => () => void;
}

function readStorage(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    // Storage blocked: the in-memory copy keeps this tab working.
  }
}

export function createTokenStore(): TokenStore {
  let token = readStorage(TOKEN_KEY);
  let mfa = readStorage(MFA_KEY) === '1';
  let signedOut = false;
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((listener) => listener());

  return {
    getToken: () => token,
    setToken(next, options) {
      token = next;
      signedOut = false;
      mfa = options?.mfaElevated ?? false;
      writeStorage(TOKEN_KEY, next);
      writeStorage(MFA_KEY, mfa ? '1' : null);
      emit();
    },
    clear() {
      token = null;
      mfa = false;
      writeStorage(TOKEN_KEY, null);
      writeStorage(MFA_KEY, null);
      emit();
    },
    signOut() {
      signedOut = true;
      token = null;
      mfa = false;
      writeStorage(TOKEN_KEY, null);
      writeStorage(MFA_KEY, null);
      emit();
    },
    isSignedOut: () => signedOut,
    isMfaElevated: () => mfa,
    setMfaElevated(value) {
      mfa = value;
      writeStorage(MFA_KEY, value ? '1' : null);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const tokenStore: TokenStore = createTokenStore();

/** Re-renders when the token changes. */
export function useSessionToken(store: TokenStore = tokenStore): string | null {
  return useSyncExternalStore(store.subscribe, store.getToken);
}

export function useMfaElevated(store: TokenStore = tokenStore): boolean {
  return useSyncExternalStore(store.subscribe, store.isMfaElevated);
}
