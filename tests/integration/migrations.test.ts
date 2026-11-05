/**
 * Migration harness integration evidence (requires PostgreSQL).
 *
 * SUAS-specs ENVIRONMENT.md §3 "Data / persistence", §5, §9;
 * SUAS-specs VERSIONING.md §3.5;
 * SUAS-specs TESTING.md §2 "Migration/restore" layer.
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EXPECTED_SCHEMA_VERSION,
  loadMigrationFiles,
  resolveMigrationsDir,
  MIGRATIONS_TABLE,
  readAppliedMigrations,
  readSchemaVersion,
  runMigrations,
  SchemaStateError,
} from '../../src/db/index.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';
import { migrationsTestDatabaseUrl } from '../helpers/env.js';

const provenance = { specVersion: SPEC_VERSION, releaseManifest: RELEASE_MANIFEST };

/** Every migration version on disk, so these tests stay correct as slices add them. */
async function allMigrationVersions(): Promise<number[]> {
  return (await loadMigrationFiles()).map((file) => file.version);
}
// This suite rebuilds the schema from empty, so it owns a database of its own.
const pool = new Pool({ connectionString: migrationsTestDatabaseUrl(), max: 4 });

/**
 * Return the database to empty. Dropping the whole schema keeps this correct as
 * migrations are added, rather than needing a hand-maintained list of objects.
 */
async function resetDatabase(): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
}

beforeEach(resetDatabase);
afterAll(async () => {
  await resetDatabase();
  await pool.end();
});

describe('apply mode', () => {
  it('applies pending migrations and records the schema version', async () => {
    const versions = await allMigrationVersions();
    const result = await runMigrations(pool, { mode: 'apply', provenance });
    expect(result.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(result.appliedNow).toEqual(versions);

    const applied = await readAppliedMigrations(pool);
    expect(applied).toHaveLength(versions.length);
    expect(applied[0]?.name).toBe('baseline');
  });

  it('is idempotent when re-run', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    const second = await runMigrations(pool, { mode: 'apply', provenance });
    expect(second.appliedNow).toEqual([]);
    expect(second.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it('records the released spec stack the schema was built for', async () => {
    const result = await runMigrations(pool, { mode: 'apply', provenance });
    expect(result.schemaProvenance).toEqual({
      specVersion: SPEC_VERSION,
      releaseManifest: RELEASE_MANIFEST,
    });
    expect(result.specStackDrift).toBe(false);
  });

  it('serializes concurrent runs so a migration is applied once', async () => {
    const results = await Promise.all([
      runMigrations(pool, { mode: 'apply', provenance }),
      runMigrations(pool, { mode: 'apply', provenance }),
    ]);
    // Each migration is applied exactly once across both concurrent runs.
    const totalApplied = results.flatMap((result) => result.appliedNow).sort((a, b) => a - b);
    expect(totalApplied).toEqual(await allMigrationVersions());
    expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);
  });
});

describe('validate mode', () => {
  it('passes against a fully migrated database', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    const result = await runMigrations(pool, { mode: 'validate', provenance });
    expect(result.schemaVersion).toBe(EXPECTED_SCHEMA_VERSION);
    expect(result.appliedNow).toEqual([]);
  });

  it('rejects a database with pending migrations', async () => {
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      SchemaStateError,
    );
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /migration\(s\) are pending/,
    );
  });

  it('never mutates the schema', async () => {
    await runMigrations(pool, { mode: 'validate', provenance }).catch(() => undefined);
    const applied = await readAppliedMigrations(pool);
    expect(applied).toHaveLength(0);
  });
});

describe('ENVIRONMENT.md §9 — reject unsafe schema states', () => {
  it('rejects a migration edited after it was applied', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    await pool.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = 'tampered' WHERE version = 1`);
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /was modified after it was applied/,
    );
  });

  it('rejects a database ahead of this build', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    await pool.query(
      `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES (99, 'future_work', 'x')`,
    );
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /has no file on disk/,
    );
  });

  it('rejects a schema version the build does not expect', async () => {
    await expect(
      runMigrations(pool, { mode: 'apply', provenance, expectedSchemaVersion: 99 }),
    ).rejects.toThrow(/this build requires 99/);
  });
});

describe('off mode', () => {
  it('performs no database work', async () => {
    const result = await runMigrations(pool, { mode: 'off', provenance });
    expect(result.schemaVersion).toBe(0);
    expect(result.appliedNow).toEqual([]);

    const exists = await pool.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [MIGRATIONS_TABLE],
    );
    expect(exists.rows[0]?.present).toBe(false);
  });
});

describe('0017 request holder backfill', () => {
  /** A migrations directory holding only versions 1 to 16, to build the old shape first. */
  async function migrationsUpTo16(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'suas-migrations-'));
    const source = resolveMigrationsDir();
    for (const name of await readdir(source)) {
      if (/^\d{4}_/.test(name) && Number.parseInt(name.slice(0, 4), 10) <= 16) {
        await cp(join(source, name), join(dir, name));
      }
    }
    return dir;
  }

  async function insertRequest(
    tenantId: string,
    caseId: string,
    creator: string,
    status: string,
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO service_requests
         (service_request_id, tenant_id, case_id, category, status, created_by)
       VALUES ($1, $2, $3, 'FOOD', $4::suas_service_request_status, $5)`,
      [id, tenantId, caseId, status, creator],
    );
    return id;
  }

  it('gives accepted requests their holder and leaves waiting ones open', async () => {
    const dir = await migrationsUpTo16();
    try {
      await runMigrations(pool, {
        mode: 'apply',
        provenance,
        migrationsDir: dir,
        expectedSchemaVersion: 16,
      });

      const tenantId = randomUUID();
      const person = async (county: string | null = null) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO users (user_id, tenant_id, status, county)
           VALUES ($1, $2, 'ACTIVE', $3::suas_county)`,
          [id, tenantId, county],
        );
        return id;
      };
      const [veteranA, helperA, veteranB, helperB] = await Promise.all([
        person(),
        person(),
        person(),
        person(),
      ]);
      const makeCase = async (veteran: string, status: string) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO support_cases (case_id, tenant_id, veteran_user_id, status)
           VALUES ($1, $2, $3, $4::suas_case_status)`,
          [id, tenantId, veteran, status],
        );
        return id;
      };
      const assign = (caseId: string, helper: string, status: string) =>
        pool.query(
          `INSERT INTO case_assignments
             (case_assignment_id, tenant_id, case_id, accepted_by_user_id, status)
           VALUES ($1, $2, $3, $4, $5::suas_case_assignment_status)`,
          [randomUUID(), tenantId, caseId, helper, status],
        );
      const thread = (requestId: string, requester: string, helper: string) =>
        pool.query(
          `INSERT INTO chat_threads
             (chat_thread_id, tenant_id, service_request_id, requester_user_id, accepted_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenantId, requestId, requester, helper],
        );

      // Case A is held. One request was accepted with chat, one moved past matching before
      // chat existed, one is still waiting, one was cancelled without being accepted.
      const caseA = await makeCase(veteranA, 'ACTIVE');
      await assign(caseA, helperA, 'ACTIVE');
      const accepted = await insertRequest(tenantId, caseA, veteranA, 'ACCEPTED');
      await thread(accepted, veteranA, helperA);
      const inProgress = await insertRequest(tenantId, caseA, veteranA, 'IN_PROGRESS');
      const waiting = await insertRequest(tenantId, caseA, veteranA, 'SUBMITTED');
      const cancelled = await insertRequest(tenantId, caseA, veteranA, 'CANCELLED');

      // Case B was closed and its assignment released; the chat thread still names the helper.
      const caseB = await makeCase(veteranB, 'CLOSED');
      await assign(caseB, helperB, 'RELEASED');
      const closedWithChat = await insertRequest(tenantId, caseB, veteranB, 'CLOSED');
      await thread(closedWithChat, veteranB, helperB);
      const closedNoChat = await insertRequest(tenantId, caseB, veteranB, 'CLOSED');

      const result = await runMigrations(pool, { mode: 'apply', provenance });
      expect(result.appliedNow).toEqual([17]);
      expect(await readSchemaVersion(pool)).toBe(17);

      const holders = await pool.query<{ id: string; holder: string | null }>(
        `SELECT service_request_id AS id, accepted_by_user_id AS holder FROM service_requests`,
      );
      const byId = Object.fromEntries(holders.rows.map((row) => [row.id, row.holder]));
      expect(byId).toEqual({
        [accepted]: helperA,
        [inProgress]: helperA,
        [waiting]: null,
        [cancelled]: null,
        [closedWithChat]: helperB,
        [closedNoChat]: null,
      });

      // The holder must be a user of the same tenant, and is indexed for "my requests".
      await expect(
        pool.query(
          `UPDATE service_requests SET accepted_by_user_id = $1 WHERE service_request_id = $2`,
          [randomUUID(), waiting],
        ),
      ).rejects.toThrow(/service_requests_accepted_by_fk/);
      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE indexname = 'service_requests_accepted_by_idx'`,
      );
      expect(indexes.rowCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
