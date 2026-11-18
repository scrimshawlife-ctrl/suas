import { useRef } from 'react';
import { isApiError, isConnectionError } from './errors';

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
    headers(): { 'Idempotency-Key': string } {
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
 * JSON with every object's keys sorted, so key order never makes two equal bodies differ. The
 * plain encode first fails a body the send could not encode (a cycle) with the same TypeError.
 * Takes JSON-safe request bodies only: it fingerprints what JSON.stringify sends (a Date as
 * its ISO string), so a Map, Set or Symbol is as lost here as on the wire.
 */
function canonicalJson(value: unknown): string {
  const plain: unknown = JSON.parse(JSON.stringify(value ?? null));
  return JSON.stringify(plain, (_key, part: unknown) =>
    part === null || typeof part !== 'object' || Array.isArray(part)
      ? part
      : Object.fromEntries(Object.entries(part).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/**
 * The first attempt may have run, or still be running, so only its key can replay it
 * (API.md §7 rules 3 and 5): no answer (network error, timeout), a 5xx, or a 409
 * IDEMPOTENCY_CONFLICT, which for the same key and body means that attempt is in flight
 * (`src/idempotency/run.ts`). Any other 4xx refused the action, so a retry is a new one.
 */
function keepsKey(error: unknown): boolean {
  return (
    isConnectionError(error) ||
    (isApiError(error) && (error.status >= 500 || error.code === 'IDEMPOTENCY_CONFLICT'))
  );
}

/**
 * One Idempotency-Key per user action, tied to the body it was sent with. A retry of that body
 * reuses it after a failure that `keepsKey`; a success, a refusal or a changed body starts a new
 * key, so a kept key never meets a different body (that 409 would repeat on every retry). Only
 * the latest send settles the key (`body` is that send's variables), so an older overlapping
 * send cannot renew the key a newer one may need to replay.
 */
export function useCommandKey() {
  const key = useIdempotencyKey();
  const sentWith = useRef<string | null>(null);
  const latest = useRef<unknown>(undefined);
  return {
    headers: (body?: unknown) => {
      const fingerprint = canonicalJson(body);
      if (sentWith.current !== fingerprint) key.renew();
      sentWith.current = fingerprint;
      latest.current = body;
      return key.headers();
    },
    settle: (body: unknown, error?: unknown) => {
      if (body !== latest.current || (error !== undefined && keepsKey(error))) return;
      // Forget the body too: the Verify page must not hold VA details past the answer.
      key.renew();
      sentWith.current = null;
      latest.current = undefined;
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
      const fingerprint = canonicalJson(body);
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
