/**
 * Request-path schema version check (Worker equivalent of validate).
 *
 * SUAS-specs ENVIRONMENT.md §9: fail closed when the recorded version is not
 * the build's required version; never apply migrations here.
 */

import { describe, expect, it } from 'vitest';
import {
  assertExpectedSchemaVersion,
  EXPECTED_SCHEMA_VERSION,
  SchemaStateError,
} from '../../src/db/index.js';

describe('assertExpectedSchemaVersion', () => {
  it('returns the version when it matches this build', async () => {
    const db = {
      query: () =>
        Promise.resolve({
          rows: [
            {
              version: EXPECTED_SCHEMA_VERSION,
              name: 'resource_contact_method_kind',
              checksum: 'abc',
              applied_at: new Date('2026-08-26T00:00:00Z'),
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        }),
    };
    await expect(assertExpectedSchemaVersion(db)).resolves.toBe(EXPECTED_SCHEMA_VERSION);
  });

  it('fails closed when the recorded version is not 11', async () => {
    const db = {
      query: () =>
        Promise.resolve({
          rows: [
            {
              version: 10,
              name: 'notification_subject',
              checksum: 'abc',
              applied_at: new Date('2026-08-26T00:00:00Z'),
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        }),
    };
    await expect(assertExpectedSchemaVersion(db)).rejects.toBeInstanceOf(SchemaStateError);
    await expect(assertExpectedSchemaVersion(db)).rejects.toThrow(/requires 11/);
    await expect(assertExpectedSchemaVersion(db)).rejects.toThrow(/never applies migrations/);
  });

  it('fails closed when the bookkeeping table cannot be read', async () => {
    const db = {
      query: () => Promise.reject(new Error('relation "suas_schema_migrations" does not exist')),
    };
    await expect(assertExpectedSchemaVersion(db)).rejects.toBeInstanceOf(SchemaStateError);
    await expect(assertExpectedSchemaVersion(db)).rejects.toThrow(/Could not read schema version/);
  });
});
