/**
 * Amazon S3 adapter for the object storage port.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.2, §4.1. Region comes from
 * configuration and credentials from the AWS default provider chain. Bucket
 * encryption and access policy belong to the infrastructure (CDK), not here.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  type DeleteObjectCommandOutput,
  type GetObjectCommandOutput,
  type PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { awsErrorName, isAwsTimeout } from '../aws/errors.js';
import { OUTBOUND_FETCH_TIMEOUT_MS } from '../resilience/outbound-fetch.js';
import {
  assertObjectKey,
  ObjectStorageError,
  type ObjectStoragePort,
  type PutObjectInput,
  type StoredObject,
} from './object-storage.js';

export const S3_IMPLEMENTATION = 's3' as const;

/** The one S3 client method this adapter uses; tests supply a fake. */
export interface S3ClientLike {
  send(
    command: PutObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<PutObjectCommandOutput>;
  send(
    command: GetObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<GetObjectCommandOutput>;
  send(
    command: DeleteObjectCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<DeleteObjectCommandOutput>;
}

export interface S3ObjectStorageOptions {
  readonly bucket: string;
  readonly region: string;
  readonly client?: S3ClientLike;
}

export class S3ObjectStorage implements ObjectStoragePort {
  readonly implementation = S3_IMPLEMENTATION;

  private readonly bucket: string;
  private readonly client: S3ClientLike;

  constructor(options: S3ObjectStorageOptions) {
    this.bucket = options.bucket;
    this.client = options.client ?? new S3Client({ region: options.region });
  }

  async put(input: PutObjectInput): Promise<void> {
    assertObjectKey(input.key);
    await this.call(() =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: input.key,
          Body: input.body,
          ContentType: input.contentType,
        }),
        abortOptions(),
      ),
    );
  }

  async get(key: string): Promise<StoredObject | undefined> {
    assertObjectKey(key);
    return this.call(async () => {
      let output: GetObjectCommandOutput;
      try {
        output = await this.client.send(
          new GetObjectCommand({ Bucket: this.bucket, Key: key }),
          abortOptions(),
        );
      } catch (error: unknown) {
        if (awsErrorName(error) === 'NoSuchKey') return undefined;
        throw error;
      }
      if (output.Body === undefined) return undefined;
      return { body: await output.Body.transformToByteArray(), contentType: output.ContentType };
    });
  }

  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    await this.call(() =>
      this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), abortOptions()),
    );
  }

  /** Maps any SDK failure to the port's typed error; SDK errors never escape. */
  private async call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      throw new ObjectStorageError(isAwsTimeout(error) ? 'timeout' : 'unavailable');
    }
  }
}

function abortOptions(): { abortSignal: AbortSignal } {
  return { abortSignal: AbortSignal.timeout(OUTBOUND_FETCH_TIMEOUT_MS) };
}
