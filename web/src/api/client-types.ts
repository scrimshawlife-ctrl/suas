import type { paths as GeneratedPaths } from './schema';
import type { SupplementedPath, SupplementPaths } from './supplement';

/**
 * Every write sends `Idempotency-Key` from the client middleware, so callers never pass
 * it. This makes the generated required header optional in the request types.
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

/** The `/api/v0` contract as the web client sees it: generated paths plus the supplement. */
export type ApiPaths = Loosened<Omit<GeneratedPaths, SupplementedPath>> & SupplementPaths;
