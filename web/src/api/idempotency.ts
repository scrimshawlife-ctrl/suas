import { useRef } from 'react';
import { isApiError } from './errors';

/*
 * Idempotency-Key holders for mutation hooks, so a retry of one action reuses its key (the
 * client's random per-request fallback cannot). Each variant is a renew policy in use today;
 * one policy for every hook is an owner call, so each hook keeps the one it has.
 */

/** One key per user action: the same key across retries, a new one after `renew()`. */
export function useIdempotencyKey() {
  const ref = useRef<string | null>(null);
  return {
    /** The current key, created on first use. */
    current(): string {
      ref.current ??= crypto.randomUUID();
      return ref.current;
    },
    /** `headers` option for the API client: `api.POST(path, { body, headers: key.headers() })`. */
    headers(): Record<string, string> {
      ref.current ??= crypto.randomUUID();
      return { 'Idempotency-Key': ref.current };
    },
    /** Drops the key so the next action gets a new one. */
    renew(): void {
      ref.current = null;
    },
  };
}

export type IdempotencyKey = ReturnType<typeof useIdempotencyKey>;

/**
 * One key per action, renewed after a success or a refusal (4xx), since the next attempt then
 * has a different body. A 5xx or a dropped response keeps it for the retry.
 */
export function useCommandKey() {
  const key = useIdempotencyKey();
  return {
    headers: () => key.headers(),
    /** Call with no error after a success, or with the error after a failure. */
    settle: (error?: unknown) => {
      if (error === undefined || (isApiError(error) && error.status < 500)) key.renew();
    },
  };
}

/** One key per target (a request id, a command, a body), so a retry of that target reuses it. */
export function useKeyedIdempotency() {
  const keys = useRef(new Map<string, string>());
  return {
    headers(target: string): Record<string, string> {
      let key = keys.current.get(target);
      if (key === undefined) {
        key = crypto.randomUUID();
        keys.current.set(target, key);
      }
      return { 'Idempotency-Key': key };
    },
    renew(target: string): void {
      keys.current.delete(target);
    },
  };
}

/**
 * One key for the last body sent: the same body again reuses it, a changed body gets a new one.
 * Only the last body is kept, so going back to an earlier body is a new action.
 */
export function useBodyIdempotencyKey() {
  const last = useRef<{ body: string; key: string } | null>(null);
  return {
    headers(body: unknown): Record<string, string> {
      const fingerprint = JSON.stringify(body);
      if (last.current?.body !== fingerprint) {
        last.current = { body: fingerprint, key: crypto.randomUUID() };
      }
      return { 'Idempotency-Key': last.current.key };
    },
    renew(): void {
      last.current = null;
    },
  };
}
