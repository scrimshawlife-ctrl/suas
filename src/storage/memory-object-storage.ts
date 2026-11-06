/**
 * In-memory fake for the object storage port (LOCAL/TEST; AGENTS.md rule 7).
 * Process-local on purpose: it is never used for correctness-critical state.
 */

import {
  assertObjectKey,
  type ObjectStoragePort,
  type PutObjectInput,
  type StoredObject,
} from './object-storage.js';

export class InMemoryObjectStorage implements ObjectStoragePort {
  readonly implementation = 'in-memory-fake';

  private readonly objects = new Map<string, StoredObject>();

  put(input: PutObjectInput): Promise<void> {
    assertObjectKey(input.key);
    this.objects.set(input.key, { body: input.body.slice(), contentType: input.contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<StoredObject | undefined> {
    assertObjectKey(key);
    const stored = this.objects.get(key);
    return Promise.resolve(stored && { ...stored, body: stored.body.slice() });
  }

  delete(key: string): Promise<void> {
    assertObjectKey(key);
    this.objects.delete(key);
    return Promise.resolve();
  }

  /** Test-only inspection. */
  keys(): readonly string[] {
    return [...this.objects.keys()];
  }
}
