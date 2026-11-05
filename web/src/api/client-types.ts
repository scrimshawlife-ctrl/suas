import type { paths } from './schema';

/**
 * Every write sends `Idempotency-Key` from the client middleware, so callers never have to
 * pass it. The document marks the header required on many writes; this makes it optional in
 * the request types (a caller may still pass one for a stable key, see idempotency.ts).
 */
type LoosenIdempotency<Operation> = Operation extends { parameters: infer P }
  ? Omit<Operation, 'parameters'> & {
      parameters: P extends { header: infer H }
        ? Omit<P, 'header'> & {
            header?: Omit<H, 'Idempotency-Key'> & { 'Idempotency-Key'?: string };
          }
        : P;
    }
  : Operation;

type Loosened<T> = {
  [Path in keyof T]: { [Method in keyof T[Path]]: LoosenIdempotency<T[Path][Method]> };
};

/** The `/api/v0` contract as the web client sees it. */
export type ApiPaths = Loosened<paths>;
