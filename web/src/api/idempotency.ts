import { useRef } from 'react';
import { isApiError, isConnectionError } from './errors';

/**
 * One `Idempotency-Key` per user action. The client adds a random key to every write as a
 * fallback, but a fresh key per request means a double click or a retry after a dropped
 * response can create twice. A screen that submits holds one key per submit instead:
 *
 *   const key = useIdempotencyKey();
 *   const create = useMutation({
 *     mutationFn: (input: Input) => api.POST(path, { body: input, headers: key.headers() }),
 *     onSuccess: key.renew,
 *   });
 *
 * The key stays the same across retries of the same action and changes after a success.
 */
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
    /** Call after the action succeeded so the next action gets a new key. */
    renew(): void {
      ref.current = null;
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
