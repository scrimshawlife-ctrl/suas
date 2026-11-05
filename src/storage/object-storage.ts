/**
 * Object storage capability port: put, get and delete by key.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.2 (S3 for assets), §4.1. AGENTS.md
 * rule 6 (the SDK stays in the adapter). Callers own key naming and must not
 * put personal data in keys: keys appear in provider logs and error messages.
 */

export interface PutObjectInput {
  readonly key: string;
  readonly body: Uint8Array;
  readonly contentType: string;
}

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string | undefined;
}

/** `unavailable`: provider error or no access. `timeout`: no answer in time. */
export type ObjectStorageFailureKind = 'unavailable' | 'timeout';

export class ObjectStorageError extends Error {
  constructor(readonly kind: ObjectStorageFailureKind) {
    super(`Object storage ${kind}`);
    this.name = 'ObjectStorageError';
  }
}

export class InvalidObjectKeyError extends Error {
  constructor() {
    super('Object key must be 1 to 1024 bytes of UTF-8 and must not start with "/".');
    this.name = 'InvalidObjectKeyError';
  }
}

export function assertObjectKey(key: string): void {
  const bytes = new TextEncoder().encode(key).length;
  if (bytes === 0 || bytes > 1024 || key.startsWith('/')) throw new InvalidObjectKeyError();
}

export interface ObjectStoragePort {
  readonly implementation: string;
  /** Replaces any object already at the key. */
  put(input: PutObjectInput): Promise<void>;
  /** Resolves undefined when no object exists at the key. */
  get(key: string): Promise<StoredObject | undefined>;
  /** Succeeds when the key is already absent, so retries are safe. */
  delete(key: string): Promise<void>;
}
