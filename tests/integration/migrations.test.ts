/**
 * Migration harness integration evidence (requires PostgreSQL).
 *
 * SUAS-specs ENVIRONMENT.md §3 "Data / persistence", §5, §9;
 * SUAS-specs VERSIONING.md §3.5;
 * SUAS-specs TESTING.md §2 "Migration/restore" layer.
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  databaseNameFromUrl,
  EXPECTED_SCHEMA_VERSION,
  loadMigrationFiles,
  resolveMigrationsDir,
  MIGRATIONS_TABLE,
  readAppliedMigrations,
  readSchemaVersion,
  resetSyntheticDatabase,
  runMigrations,
  SchemaStateError,
} from '../../src/db/index.js';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';
import { migrationsTestDatabaseUrl, testDatabaseUrl } from '../helpers/env.js';

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

const AMBIENT_KEYS = [
  'DATABASE_URL',
  'PGHOST',
  'PGPORT',
  'PGUSER',
  'PGPASSWORD',
  'PGDATABASE',
] as const;

async function withAmbient(
  values: Partial<Record<(typeof AMBIENT_KEYS)[number], string | undefined>>,
  fn: () => Promise<void>,
): Promise<void> {
  const saved = new Map(AMBIENT_KEYS.map((key) => [key, process.env[key]]));
  for (const key of AMBIENT_KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const key of AMBIENT_KEYS) {
      if (!Object.hasOwn(values, key)) continue;
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function captureQueries(target: Pool): { queries: string[]; restore: () => void } {
  const queries: string[] = [];
  const originalQuery = target.query.bind(target);
  const originalConnect = target.connect.bind(target);
  const record = (queryConfig: unknown): void => {
    if (typeof queryConfig === 'string') {
      queries.push(queryConfig);
      return;
    }
    if (
      queryConfig !== null &&
      typeof queryConfig === 'object' &&
      'text' in queryConfig &&
      typeof queryConfig.text === 'string'
    ) {
      queries.push(queryConfig.text);
    }
  };

  const wrapClient = (client: PoolClient): PoolClient => {
    const originalClientQuery = client.query.bind(client);
    client.query = function clientQuery(this: PoolClient, ...clientArgs: unknown[]): unknown {
      record(clientArgs[0]);
      return (originalClientQuery as (...queryArgs: unknown[]) => unknown).apply(this, clientArgs);
    } as PoolClient['query'];
    return client;
  };

  target.query = function query(this: Pool, ...args: unknown[]): unknown {
    record(args[0]);
    return (originalQuery as (...queryArgs: unknown[]) => unknown).apply(this, args);
  } as Pool['query'];
  target.connect = function connect(this: Pool, ...args: unknown[]): unknown {
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      const userCallback = last as (error: Error | undefined, client: PoolClient) => void;
      args[args.length - 1] = (error: Error | undefined, client: PoolClient) => {
        if (client !== undefined) wrapClient(client);
        userCallback(error, client);
      };
      return (originalConnect as (...connectArgs: unknown[]) => unknown).apply(this, args);
    }
    const pending = (originalConnect as (...connectArgs: unknown[]) => Promise<PoolClient>).apply(
      this,
      args,
    );
    return pending.then((client) => wrapClient(client));
  } as Pool['connect'];

  return {
    queries,
    restore: () => {
      target.query = originalQuery;
      target.connect = originalConnect;
    },
  };
}

function expectNoDestructiveStatement(queries: readonly string[]): void {
  for (const query of queries) {
    expect(query).not.toMatch(/\bdrop\s+schema\b/i);
    expect(query).not.toMatch(/\bdrop\s+table\b/i);
    expect(query).not.toMatch(/\btruncate\b/i);
    expect(query).not.toMatch(/\bdrop\s+database\b/i);
  }
}

async function explicitResetUrl(baseUrl: string, database: string): Promise<string> {
  const observed = await pool.query<{ server_addr: string | null; server_port: number | null }>(
    'SELECT host(inet_server_addr()) AS server_addr, inet_server_port() AS server_port',
  );
  const address = observed.rows[0]?.server_addr ?? '';
  const port = observed.rows[0]?.server_port;
  expect(isIP(address)).not.toBe(0);
  expect(port).toEqual(expect.any(Number));
  const parsed = new URL(baseUrl);
  const host = isIP(address) === 6 ? `[${address}]` : address;
  return `postgresql://${encodeURIComponent(decodeURIComponent(parsed.username))}:${encodeURIComponent(decodeURIComponent(parsed.password))}@${host}:${String(port)}/${database}`;
}

async function preparedSchema(): Promise<number> {
  await runMigrations(pool, { mode: 'apply', provenance });
  await pool.query('DROP TABLE IF EXISTS public.reset_probe');
  await pool.query('CREATE TABLE public.reset_probe (id int)');
  return readSchemaVersion(pool);
}

async function expectSchemaUnchanged(version: number): Promise<void> {
  expect(await readSchemaVersion(pool)).toBe(version);
  const probe = await pool.query<{ present: string | null }>(
    `SELECT to_regclass('public.reset_probe') AS present`,
  );
  expect(probe.rows[0]?.present).not.toBeNull();
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

describe('D-053 — reset only a named synthetic disposable database', () => {
  const url = migrationsTestDatabaseUrl();
  const name = databaseNameFromUrl(url);

  it('refuses an unnamed or non-synthetic target and leaves the schema', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    await expect(
      resetSyntheticDatabase(
        pool,
        {
          environment: 'TEST',
          databaseUrl: url,
          allowlist: [],
          syntheticMarker: name,
        },
        provenance,
      ),
    ).rejects.toThrow(/unnamed target/);
    await expect(
      resetSyntheticDatabase(
        pool,
        {
          environment: 'TEST',
          databaseUrl: url,
          allowlist: name === undefined ? [] : [name],
          syntheticMarker: 'synthetic',
        },
        provenance,
      ),
    ).rejects.toThrow(/does not contain the synthetic marker/);
    await expect(
      resetSyntheticDatabase(
        pool,
        {
          environment: 'PRODUCTION',
          databaseUrl: url,
          allowlist: name === undefined ? [] : [name],
          syntheticMarker: name,
        },
        provenance,
      ),
    ).rejects.toThrow(/PRODUCTION/);
    expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);
  });

  it('resets an allowlisted synthetic database and bootstraps it cleanly', async () => {
    expect(name).toBeDefined();
    await runMigrations(pool, { mode: 'apply', provenance });
    await pool.query('CREATE TABLE public.reset_probe (id int)');
    const explicit = await explicitResetUrl(url, name ?? '');
    await withAmbient(
      {
        DATABASE_URL: explicit,
        PGHOST: undefined,
        PGPORT: undefined,
        PGUSER: undefined,
        PGPASSWORD: undefined,
        PGDATABASE: undefined,
      },
      async () => {
        await resetSyntheticDatabase(
          pool,
          {
            environment: 'TEST',
            databaseUrl: explicit,
            allowlist: [name ?? ''],
            syntheticMarker: name,
          },
          provenance,
        );
      },
    );
    const probe = await pool.query<{ present: string | null }>(
      `SELECT to_regclass('public.reset_probe') AS present`,
    );
    expect(probe.rows[0]?.present).toBeNull();
    expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);
    await pool.query(`UPDATE ${MIGRATIONS_TABLE} SET checksum = 'tampered' WHERE version = 1`);
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /was modified after it was applied/,
    );
  });
});

describe('D-053 — destructive reset is refused before any schema change', () => {
  const url = migrationsTestDatabaseUrl();
  const name = databaseNameFromUrl(url) ?? '';

  async function refuseWithoutChange(
    policy: {
      readonly environment: 'LOCAL' | 'TEST' | 'STAGING' | 'PRODUCTION';
      readonly databaseUrl: string | undefined;
      readonly allowlist: readonly string[];
      readonly syntheticMarker: string | undefined;
    },
    message?: RegExp,
  ): Promise<readonly string[]> {
    const version = await preparedSchema();
    const captured = captureQueries(pool);
    try {
      const pending = resetSyntheticDatabase(pool, policy, provenance);
      if (message === undefined) await expect(pending).rejects.toThrow(SchemaStateError);
      else await expect(pending).rejects.toThrow(message);
    } finally {
      captured.restore();
    }
    expectNoDestructiveStatement(captured.queries);
    await expectSchemaUnchanged(version);
    return captured.queries;
  }

  it('refuses a production-like URL and leaves the schema', async () => {
    const prodUrl = 'postgresql://suas:suas@prod-db.example.invalid:5432/suas_migrations_test';
    const queries = await refuseWithoutChange(
      {
        environment: 'TEST',
        databaseUrl: prodUrl,
        allowlist: ['suas_migrations_test', prodUrl],
        syntheticMarker: 'migrations_test',
      },
      /production marker/,
    );
    expect(queries.some((query) => /current_database/i.test(query))).toBe(false);
  });

  it('refuses a STAGING target and leaves the schema', async () => {
    const queries = await refuseWithoutChange(
      {
        environment: 'STAGING',
        databaseUrl: url,
        allowlist: [name],
        syntheticMarker: name,
      },
      /STAGING/,
    );
    expect(queries.some((query) => /current_database/i.test(query))).toBe(false);
  });

  it('refuses when the pool is not the authorized database and leaves the schema', async () => {
    const other = 'postgresql://suas:suas@192.0.2.1:5432/suas_migrations_test_other';
    let queries: readonly string[] = [];
    await withAmbient(
      {
        DATABASE_URL: other,
        PGHOST: undefined,
        PGPORT: undefined,
        PGUSER: undefined,
        PGPASSWORD: undefined,
        PGDATABASE: undefined,
      },
      async () => {
        queries = await refuseWithoutChange(
          {
            environment: 'TEST',
            databaseUrl: other,
            allowlist: ['suas_migrations_test_other'],
            syntheticMarker: 'migrations_test',
          },
          /checked-out connection/,
        );
      },
    );
    expect(queries.some((query) => /current_database/i.test(query))).toBe(true);
  });

  it('refuses an ambient DATABASE_URL or PGDATABASE override and leaves both schemas', async () => {
    const sharedUrl = testDatabaseUrl();
    const sharedName = databaseNameFromUrl(sharedUrl);
    const sharedPool = new Pool({ connectionString: sharedUrl, max: 1 });
    const version = await preparedSchema();
    const captured = captureQueries(pool);
    const sharedCaptured = captureQueries(sharedPool);
    try {
      await sharedPool.query('CREATE TABLE public.reset_ambient_probe (id int)');
      await withAmbient({ DATABASE_URL: sharedUrl, PGDATABASE: sharedName }, async () => {
        await expect(
          resetSyntheticDatabase(
            pool,
            {
              environment: 'TEST',
              databaseUrl: url,
              allowlist: [name],
              syntheticMarker: name,
            },
            provenance,
          ),
        ).rejects.toThrow(/DATABASE_URL does not match/);
      });
      expectNoDestructiveStatement(captured.queries);
      expectNoDestructiveStatement(sharedCaptured.queries);
      await expectSchemaUnchanged(version);
      const probe = await sharedPool.query<{ present: string | null }>(
        `SELECT to_regclass('public.reset_ambient_probe') AS present`,
      );
      expect(probe.rows[0]?.present).not.toBeNull();
    } finally {
      captured.restore();
      sharedCaptured.restore();
      await sharedPool.query('DROP TABLE IF EXISTS public.reset_ambient_probe');
      await sharedPool.end();
    }
  });

  it('refuses ambient PG* overrides and leaves the schema', async () => {
    const version = await preparedSchema();
    const captured = captureQueries(pool);
    try {
      await withAmbient(
        {
          DATABASE_URL: url,
          PGHOST: 'example.invalid',
          PGPORT: '1',
          PGUSER: 'not-the-reset-user',
          PGPASSWORD: 'not-the-reset-password',
        },
        async () => {
          await expect(
            resetSyntheticDatabase(
              pool,
              {
                environment: 'TEST',
                databaseUrl: url,
                allowlist: [name],
                syntheticMarker: name,
              },
              provenance,
            ),
          ).rejects.toThrow(/PGHOST does not match/);
        },
      );
    } finally {
      captured.restore();
    }
    expectNoDestructiveStatement(captured.queries);
    await expectSchemaUnchanged(version);
  });

  it('pins reset work to the checked-out client', async () => {
    const version = await preparedSchema();
    const explicit = await explicitResetUrl(url, name);
    const otherHost = explicit.includes('@127.0.0.1:') ? '192.0.2.1' : '127.0.0.1';
    const other = explicit.replace(/@[^/]+/, `@${otherHost}:5432`);
    const queries: string[] = [];
    let checkouts = 0;
    let queriesBeforeRelease = -1;
    const originalConnect = pool.connect.bind(pool);
    const originalQuery = pool.query.bind(pool);
    pool.query = () => {
      throw new Error('pool.query');
    };
    pool.connect = (async () => {
      checkouts += 1;
      if (checkouts > 1) throw new Error('second checkout');
      const client = await originalConnect();
      const originalClientQuery = client.query.bind(client);
      const originalRelease = client.release.bind(client);
      client.query = ((...args: unknown[]) => {
        const text = args[0];
        if (typeof text === 'string') queries.push(text);
        return (originalClientQuery as (...queryArgs: unknown[]) => unknown).apply(client, args);
      }) as PoolClient['query'];
      client.release = (...args: unknown[]) => {
        if (queriesBeforeRelease < 0) queriesBeforeRelease = queries.length;
        return (originalRelease as (...releaseArgs: unknown[]) => void).apply(client, args);
      };
      return client;
    }) as Pool['connect'];
    try {
      await withAmbient(
        {
          DATABASE_URL: other,
          PGHOST: undefined,
          PGPORT: undefined,
          PGUSER: undefined,
          PGPASSWORD: undefined,
          PGDATABASE: undefined,
        },
        async () => {
          await expect(
            resetSyntheticDatabase(
              pool,
              {
                environment: 'TEST',
                databaseUrl: other,
                allowlist: [name],
                syntheticMarker: name,
              },
              provenance,
            ),
          ).rejects.toThrow(/checked-out connection/);
        },
      );
    } finally {
      pool.connect = originalConnect;
      pool.query = originalQuery;
    }
    expect(checkouts).toBe(1);
    expect(queriesBeforeRelease).toBeGreaterThan(0);
    expectNoDestructiveStatement(queries);
    await expectSchemaUnchanged(version);
  });

  it('refuses the same database name on a different endpoint and leaves the schema', async () => {
    const explicit = await explicitResetUrl(url, name);
    const otherHost = explicit.includes('@127.0.0.1:') ? '192.0.2.1' : '127.0.0.1';
    const other = explicit.replace(/@[^/]+/, `@${otherHost}:5432`);
    let queries: readonly string[] = [];
    await withAmbient(
      {
        DATABASE_URL: other,
        PGHOST: undefined,
        PGPORT: undefined,
        PGUSER: undefined,
        PGPASSWORD: undefined,
        PGDATABASE: undefined,
      },
      async () => {
        queries = await refuseWithoutChange(
          {
            environment: 'TEST',
            databaseUrl: other,
            allowlist: [name],
            syntheticMarker: name,
          },
          /checked-out connection/,
        );
      },
    );
    expect(queries.some((query) => /inet_server_addr/i.test(query))).toBe(true);
    expect(queries.some((query) => /current_database/i.test(query))).toBe(true);
  });

  it('refuses ambiguous reset URLs and leaves the schema', async () => {
    const formatCases = [
      `postgresql://suas:suas@127.0.0.1:5432/${name}#fragment`,
      `postgresql://suas:suas@127.0.0.1:5432/${name}?host=192.0.2.1`,
      `postgresql://suas:suas@127.0.0.1:5432/${name}?port=1`,
      `postgresql://suas:suas@127.0.0.1:5432/${name}?sslmode=disable&sslmode=require`,
      `postgresql://suas:suas@127.0.0.1:5432/${name}?application_name=reset`,
      `postgresql://suas:suas@127.0.0.1/${name}`,
      `postgresql://suas@127.0.0.1:5432/${name}`,
      `postgresql://:suas@127.0.0.1:5432/${name}`,
      `postgresql://suas:suas@:5432/${name}`,
    ];
    for (const databaseUrl of formatCases) {
      await refuseWithoutChange(
        {
          environment: 'TEST',
          databaseUrl,
          allowlist: [name, databaseUrl],
          syntheticMarker: name,
        },
        /malformed/,
      );
    }
    const hostname = `postgresql://suas:suas@localhost:5432/${name}`;
    await withAmbient(
      {
        DATABASE_URL: hostname,
        PGHOST: undefined,
        PGPORT: undefined,
        PGUSER: undefined,
        PGPASSWORD: undefined,
        PGDATABASE: undefined,
      },
      async () => {
        await refuseWithoutChange(
          {
            environment: 'TEST',
            databaseUrl: hostname,
            allowlist: [name],
            syntheticMarker: name,
          },
          /unsupported or ambiguous/,
        );
      },
    );
  });

  it.each([
    ['DATABASE_URL', { DATABASE_URL: 'postgresql://suas:suas@127.0.0.1:5432/suas_test' }],
    ['PGHOST', { PGHOST: '192.0.2.1' }],
    ['PGPORT', { PGPORT: '1' }],
    ['PGUSER', { PGUSER: 'not-the-reset-user' }],
    ['PGPASSWORD', { PGPASSWORD: 'not-the-reset-password' }],
    ['PGDATABASE', { PGDATABASE: 'not_the_reset_database' }],
  ] as const)(
    'refuses an ambient %s override and leaves the schema',
    async (variable, override) => {
      const explicit = await explicitResetUrl(url, name);
      const version = await preparedSchema();
      const captured = captureQueries(pool);
      try {
        await withAmbient(
          {
            DATABASE_URL: explicit,
            PGHOST: undefined,
            PGPORT: undefined,
            PGUSER: undefined,
            PGPASSWORD: undefined,
            PGDATABASE: undefined,
            ...override,
          },
          async () => {
            await expect(
              resetSyntheticDatabase(
                pool,
                {
                  environment: 'TEST',
                  databaseUrl: explicit,
                  allowlist: [name],
                  syntheticMarker: name,
                },
                provenance,
              ),
            ).rejects.toThrow(new RegExp(`${variable} does not match`));
          },
        );
      } finally {
        captured.restore();
      }
      expectNoDestructiveStatement(captured.queries);
      await expectSchemaUnchanged(version);
    },
  );

  it('refuses a malformed URL or allowlist entry and leaves the schema', async () => {
    await refuseWithoutChange(
      {
        environment: 'TEST',
        databaseUrl: 'http://example.invalid/suas_migrations_test',
        allowlist: [name],
        syntheticMarker: name,
      },
      /malformed/,
    );
    await refuseWithoutChange(
      {
        environment: 'TEST',
        databaseUrl: url,
        allowlist: [name, 'not a name'],
        syntheticMarker: name,
      },
      /allowlist entry is malformed/,
    );
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
      expect(result.appliedNow).toEqual([17, 18]);
      expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);

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

describe('0018 current case index', () => {
  async function insertUser(tenantId: string): Promise<string> {
    const id = randomUUID();
    await pool.query(`INSERT INTO users (user_id, tenant_id, status) VALUES ($1, $2, 'ACTIVE')`, [
      id,
      tenantId,
    ]);
    return id;
  }

  const insertCase = (tenantId: string, veteran: string, status: string) =>
    pool.query(
      `INSERT INTO support_cases (case_id, tenant_id, veteran_user_id, status)
       VALUES ($1, $2, $3, $4::suas_case_status)`,
      [randomUUID(), tenantId, veteran, status],
    );

  it('lets a RESOLVED or CLOSED case sit beside a new current case, and refuses two current ones', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    const tenantId = randomUUID();
    const veteran = await insertUser(tenantId);

    await insertCase(tenantId, veteran, 'CLOSED');
    await insertCase(tenantId, veteran, 'RESOLVED');
    await insertCase(tenantId, veteran, 'OPEN');

    // Any second current case is refused, in whatever status.
    for (const status of ['OPEN', 'TRIAGED', 'ASSIGNED', 'ACTIVE', 'FOLLOWUP']) {
      await expect(insertCase(tenantId, veteran, status), status).rejects.toThrow(
        /support_cases_one_active_per_veteran/,
      );
    }
    // Another Veteran is unaffected.
    await insertCase(tenantId, await insertUser(tenantId), 'OPEN');
  });
});
