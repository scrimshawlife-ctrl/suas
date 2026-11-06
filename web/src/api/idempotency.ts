import { useRef } from 'react';

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
    headers(): Record<string, string> {
      ref.current ??= crypto.randomUUID();
      return { 'Idempotency-Key': ref.current };
    },
    /** Call after the action succeeded so the next action gets a new key. */
    renew(): void {
      ref.current = null;
    },
  };
}
