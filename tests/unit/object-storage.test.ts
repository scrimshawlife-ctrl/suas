/**
 * Object storage port: S3 adapter mapping and in-memory fake
 * (V1_PROJECT_PLAN.md §4.1).
 */

import type {
  DeleteObjectCommandOutput,
  GetObjectCommandOutput,
  PutObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import {
  createObjectStoragePort,
  InMemoryObjectStorage,
  InvalidObjectKeyError,
  ObjectStorageError,
  S3ObjectStorage,
} from '../../src/storage/index.js';
import { awsError, ScriptedAwsClient } from '../helpers/aws-fake-client.js';
import { validEnv } from '../helpers/env.js';

type S3Output = PutObjectCommandOutput | GetObjectCommandOutput | DeleteObjectCommandOutput;

function s3With(responses: Array<S3Output | Error>) {
  const client = new ScriptedAwsClient<S3Output>(responses);
  const storage = new S3ObjectStorage({
    bucket: 'suas-test-assets',
    region: 'us-west-2',
    client: client,
  });
  return { client, storage };
}

const BYTES = new Uint8Array([1, 2, 3]);

describe('S3ObjectStorage', () => {
  it('puts with bucket, key, body and content type', async () => {
    const { client, storage } = s3With([{ $metadata: {} }]);
    await storage.put({ key: 'a/b.png', body: BYTES, contentType: 'image/png' });
    expect(client.commands[0]?.input).toEqual({
      Bucket: 'suas-test-assets',
      Key: 'a/b.png',
      Body: BYTES,
      ContentType: 'image/png',
    });
    expect(client.commands[0]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('gets the body bytes and content type', async () => {
    const { storage } = s3With([
      {
        Body: { transformToByteArray: () => Promise.resolve(BYTES) },
        ContentType: 'image/png',
        $metadata: {},
      } as unknown as GetObjectCommandOutput,
    ]);
    expect(await storage.get('a/b.png')).toEqual({ body: BYTES, contentType: 'image/png' });
  });

  it('resolves undefined for a missing key', async () => {
    const { storage } = s3With([awsError('NoSuchKey')]);
    expect(await storage.get('missing')).toBeUndefined();
  });

  it('deletes by key', async () => {
    const { client, storage } = s3With([{ $metadata: {} }]);
    await storage.delete('a/b.png');
    expect(client.commands[0]?.input).toEqual({ Bucket: 'suas-test-assets', Key: 'a/b.png' });
  });

  it('maps SDK failures to the port error without leaking SDK errors', async () => {
    const { storage } = s3With([awsError('AccessDenied'), awsError('TimeoutError')]);
    await expect(storage.delete('k')).rejects.toMatchObject({
      name: 'ObjectStorageError',
      kind: 'unavailable',
    });
    await expect(storage.get('k')).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it('reports a timeout distinctly', async () => {
    const { storage } = s3With([awsError('AbortError')]);
    await expect(
      storage.put({ key: 'k', body: BYTES, contentType: 'text/plain' }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('rejects an invalid key before calling S3', async () => {
    const { client, storage } = s3With([]);
    await expect(storage.get('')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    await expect(storage.delete('/leading')).rejects.toBeInstanceOf(InvalidObjectKeyError);
    expect(client.commands).toHaveLength(0);
  });
});

describe('InMemoryObjectStorage', () => {
  it('round-trips, replaces and deletes idempotently', async () => {
    const storage = new InMemoryObjectStorage();
    await storage.put({ key: 'k', body: BYTES, contentType: 'image/png' });
    expect(await storage.get('k')).toEqual({ body: BYTES, contentType: 'image/png' });

    await storage.put({ key: 'k', body: new Uint8Array([9]), contentType: 'text/plain' });
    expect(await storage.get('k')).toEqual({
      body: new Uint8Array([9]),
      contentType: 'text/plain',
    });

    await storage.delete('k');
    await storage.delete('k');
    expect(await storage.get('k')).toBeUndefined();
  });

  it('does not alias stored bytes', async () => {
    const storage = new InMemoryObjectStorage();
    const body = new Uint8Array([1]);
    await storage.put({ key: 'k', body, contentType: 'x/y' });
    body[0] = 7;
    expect((await storage.get('k'))?.body[0]).toBe(1);
  });
});

describe('createObjectStoragePort', () => {
  it('selects by config mode', () => {
    expect(createObjectStoragePort(loadConfig(validEnv()))).toBeUndefined();
    expect(
      createObjectStoragePort(loadConfig(validEnv({ SUAS_OBJECT_STORAGE_MODE: 'fake' }))),
    ).toBeInstanceOf(InMemoryObjectStorage);
    expect(
      createObjectStoragePort(
        loadConfig(
          validEnv({
            SUAS_ENV: 'STAGING',
            SUAS_OBJECT_STORAGE_MODE: 's3',
            SUAS_AWS_REGION: 'us-west-2',
            SUAS_S3_BUCKET: 'suas-staging-assets',
          }),
        ),
      ),
    ).toBeInstanceOf(S3ObjectStorage);
  });
});
