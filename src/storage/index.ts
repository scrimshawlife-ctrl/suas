import type { SuasConfig } from '../config/index.js';
import { InMemoryObjectStorage } from './memory-object-storage.js';
import type { ObjectStoragePort } from './object-storage.js';
import { S3ObjectStorage } from './s3-object-storage.js';

export { InMemoryObjectStorage } from './memory-object-storage.js';
export {
  assertObjectKey,
  InvalidObjectKeyError,
  ObjectStorageError,
  type ObjectStorageFailureKind,
  type ObjectStoragePort,
  type PutObjectInput,
  type StoredObject,
} from './object-storage.js';
export {
  S3_IMPLEMENTATION,
  S3ObjectStorage,
  type S3ClientLike,
  type S3ObjectStorageOptions,
} from './s3-object-storage.js';

/**
 * Object storage for this configuration, or undefined when disabled so callers
 * report the capability unavailable. Config validation guarantees `s3` has a
 * region and bucket and is not used in LOCAL/TEST.
 */
export function createObjectStoragePort(config: SuasConfig): ObjectStoragePort | undefined {
  const { mode, bucket } = config.objectStorage;
  if (mode === 'fake') return new InMemoryObjectStorage();
  if (mode === 's3' && bucket !== undefined && config.aws.region !== undefined) {
    return new S3ObjectStorage({ bucket, region: config.aws.region });
  }
  return undefined;
}
