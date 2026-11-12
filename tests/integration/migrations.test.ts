/**
 * Migration harness integration evidence (requires PostgreSQL).
 *
 * SUAS-specs ENVIRONMENT.md §3 "Data / persistence", §5, §9;
 * SUAS-specs VERSIONING.md §3.5;
 * SUAS-specs TESTING.md §2 "Migration/restore" layer.
 */

import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AMBIENT_SESSION_ENV_KEYS } from '../../src/config/ambient-connection.js';
import {
  checksumOf,
  databaseNameFromUrl,
  ensureMigrationsTable,
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
  ...AMBIENT_SESSION_ENV_KEYS,
] as const;

/** Session and routing variables the reset must see as unset. */
function clearedSession(): Partial<Record<(typeof AMBIENT_KEYS)[number], undefined>> {
  return Object.fromEntries(AMBIENT_SESSION_ENV_KEYS.map((key) => [key, undefined]));
}

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

/** Any DDL, not only the statements the reset itself uses. */
const DDL_STATEMENT =
  /\b(create|drop|alter|truncate|grant|revoke|comment|reindex|cluster|vacuum|refresh\s+materialized|security\s+label)\b/i;

function expectNoDdl(queries: readonly string[]): void {
  for (const query of queries) {
    expect(query).not.toMatch(DDL_STATEMENT);
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

  it('never mutates the schema, not even to create its bookkeeping table (A4-16)', async () => {
    await expect(runMigrations(pool, { mode: 'validate', provenance })).rejects.toThrow(
      /migration\(s\) are pending/,
    );
    const table = await pool.query<{ present: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AS present`,
      [MIGRATIONS_TABLE],
    );
    expect(table.rows[0]?.present).toBe(false);
  });
});

describe('D-053 — reset only a named synthetic disposable database', () => {
  const url = migrationsTestDatabaseUrl();
  const name = databaseNameFromUrl(url);

  it('refuses an unnamed or non-synthetic target and leaves the schema', async () => {
    await runMigrations(pool, { mode: 'apply', provenance });
    const captured = captureQueries(pool);
    try {
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
    } finally {
      captured.restore();
    }
    expectNoDdl(captured.queries);
    expect(captured.queries).toEqual([]);
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
        ...clearedSession(),
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

  it('uses one real client for the endpoint check, the rebuild, and the baseline, and releases it last', async () => {
    expect(name).toBeDefined();
    await runMigrations(pool, { mode: 'apply', provenance });
    await pool.query('CREATE TABLE public.reset_probe (id int)');
    const explicit = await explicitResetUrl(url, name ?? '');
    const events: string[] = [];
    const clientSql: string[] = [];
    let clients = 0;
    const originalConnect = pool.connect.bind(pool);
    const originalQuery = pool.query.bind(pool);
    pool.query = ((...args: unknown[]) => {
      events.push('pool.query');
      return (originalQuery as (...queryArgs: unknown[]) => unknown).apply(pool, args);
    }) as Pool['query'];
    pool.connect = (async () => {
      clients += 1;
      const id = clients;
      events.push(`connect:${String(id)}`);
      const client = await originalConnect();
      const originalClientQuery = client.query.bind(client);
      const originalRelease = client.release.bind(client);
      client.query = ((...args: unknown[]) => {
        const text = args[0];
        const sql = typeof text === 'string' ? text : '';
        clientSql.push(sql);
        const kind = /inet_server_addr/i.test(sql)
          ? 'observe'
          : /^\s*drop\s+schema\b/i.test(sql)
            ? 'drop'
            : /^\s*create\s+schema\b/i.test(sql)
              ? 'create-schema'
              : 'statement';
        events.push(`query:${String(id)}:${kind}`);
        return (originalClientQuery as (...queryArgs: unknown[]) => unknown).apply(client, args);
      }) as PoolClient['query'];
      client.release = (...args: unknown[]) => {
        events.push(`release:${String(id)}`);
        return (originalRelease as (...releaseArgs: unknown[]) => void).apply(client, args);
      };
      return client;
    }) as Pool['connect'];
    try {
      await withAmbient(
        {
          DATABASE_URL: explicit,
          PGHOST: undefined,
          PGPORT: undefined,
          PGUSER: undefined,
          PGPASSWORD: undefined,
          PGDATABASE: undefined,
          ...clearedSession(),
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
    } finally {
      pool.connect = originalConnect;
      pool.query = originalQuery;
    }
    expect(clients).toBe(1);
    expect(events).not.toContain('pool.query');
    expect(clientSql[0] ?? '').toMatch(/inet_server_addr/i);
    expect(clientSql[1] ?? '').toMatch(/^\s*drop\s+schema\b/i);
    expect(clientSql[2] ?? '').toMatch(/^\s*create\s+schema\b/i);
    expect(clientSql.slice(3).some((sql) => /\bcreate\b/i.test(sql))).toBe(true);
    expect(events.indexOf('query:1:observe')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('query:1:drop')).toBeGreaterThan(events.indexOf('query:1:observe'));
    expect(events.indexOf('query:1:create-schema')).toBeGreaterThan(events.indexOf('query:1:drop'));
    expect(events.indexOf('query:1:statement')).toBeGreaterThan(
      events.indexOf('query:1:create-schema'),
    );
    expect(events.at(-1)).toBe('release:1');
    expect(events.filter((event) => event.startsWith('connect:'))).toEqual(['connect:1']);
    expect(events.filter((event) => event.startsWith('release:'))).toEqual(['release:1']);
    const probe = await pool.query<{ present: string | null }>(
      `SELECT to_regclass('public.reset_probe') AS present`,
    );
    expect(probe.rows[0]?.present).toBeNull();
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
    expectNoDdl(captured.queries);
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
    try {
      const version = await preparedSchema();
      await sharedPool.query('CREATE TABLE public.reset_ambient_probe (id int)');
      const captured = captureQueries(pool);
      const sharedCaptured = captureQueries(sharedPool);
      try {
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
        expectNoDdl(captured.queries);
        expectNoDdl(sharedCaptured.queries);
        await expectSchemaUnchanged(version);
        const probe = await sharedPool.query<{ present: string | null }>(
          `SELECT to_regclass('public.reset_ambient_probe') AS present`,
        );
        expect(probe.rows[0]?.present).not.toBeNull();
      } finally {
        captured.restore();
        sharedCaptured.restore();
        await sharedPool.query('DROP TABLE IF EXISTS public.reset_ambient_probe');
      }
    } finally {
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
    expectNoDdl(captured.queries);
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
    expectNoDdl(queries);
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
            ...clearedSession(),
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
      expectNoDdl(captured.queries);
      await expectSchemaUnchanged(version);
    },
  );

  it.each(AMBIENT_SESSION_ENV_KEYS)('refuses a set %s and runs no DDL', async (variable) => {
    const explicit = await explicitResetUrl(url, name);
    let queries: readonly string[] = [];
    await withAmbient(
      {
        DATABASE_URL: explicit,
        PGHOST: undefined,
        PGPORT: undefined,
        PGUSER: undefined,
        PGPASSWORD: undefined,
        PGDATABASE: undefined,
        ...clearedSession(),
        [variable]: 'reset-must-not-apply',
      },
      async () => {
        queries = await refuseWithoutChange(
          {
            environment: 'TEST',
            databaseUrl: explicit,
            allowlist: [name],
            syntheticMarker: name,
          },
          new RegExp(`${variable} is set`),
        );
      },
    );
    expect(queries).toEqual([]);
  });

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
      expect(result.appliedNow).toEqual([17, 18, 19, 20, 21]);
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

describe('0020 request expiry and release', () => {
  /** A migrations directory holding only versions 1 to 19, to build the old shape first. */
  async function migrationsUpTo19(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'suas-migrations-'));
    const source = resolveMigrationsDir();
    for (const name of await readdir(source)) {
      if (/^\d{4}_/.test(name) && Number.parseInt(name.slice(0, 4), 10) <= 19) {
        await cp(join(source, name), join(dir, name));
      }
    }
    return dir;
  }

  it('seeds the TTL, backfills accepted_at, and allows one live thread per request', async () => {
    const dir = await migrationsUpTo19();
    try {
      await runMigrations(pool, {
        mode: 'apply',
        provenance,
        migrationsDir: dir,
        expectedSchemaVersion: 19,
      });

      const tenantId = randomUUID();
      const person = async () => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO users (user_id, tenant_id, status) VALUES ($1, $2, 'ACTIVE')`,
          [id, tenantId],
        );
        return id;
      };
      const [requester, helper, other] = await Promise.all([person(), person(), person()]);
      const caseId = randomUUID();
      await pool.query(
        `INSERT INTO support_cases (case_id, tenant_id, veteran_user_id, status)
         VALUES ($1, $2, $3, 'ASSIGNED')`,
        [caseId, tenantId, requester],
      );
      const request = async (status: string) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO service_requests
             (service_request_id, tenant_id, case_id, category, status, created_by)
           VALUES ($1, $2, $3, 'FOOD', $4::suas_service_request_status, $5)`,
          [id, tenantId, caseId, status, requester],
        );
        return id;
      };
      const accepted = await request('ACCEPTED');
      const waiting = await request('SUBMITTED');
      const threadId = randomUUID();
      const threadCreatedAt = '2026-01-02T03:04:05.000Z';
      await pool.query(
        `INSERT INTO chat_threads
           (chat_thread_id, tenant_id, service_request_id, requester_user_id,
            accepted_by_user_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [threadId, tenantId, accepted, requester, helper, threadCreatedAt],
      );

      const result = await runMigrations(pool, { mode: 'apply', provenance });
      expect(result.appliedNow).toEqual([20, 21]);
      expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);

      const setting = await pool.query<{ value: unknown }>(
        `SELECT value FROM app_settings WHERE setting_key = 'request_expiry_hours'`,
      );
      expect(setting.rows[0]?.value).toBe(72);

      const accepts = await pool.query<{ id: string; accepted_at: Date | null }>(
        `SELECT service_request_id AS id, accepted_at FROM service_requests`,
      );
      const byId = Object.fromEntries(accepts.rows.map((row) => [row.id, row.accepted_at]));
      expect(byId[accepted]?.toISOString()).toBe(threadCreatedAt);
      expect(byId[waiting]).toBeNull();

      const insertThread = () =>
        pool.query(
          `INSERT INTO chat_threads
             (chat_thread_id, tenant_id, service_request_id, requester_user_id, accepted_by_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [randomUUID(), tenantId, accepted, requester, other],
        );
      // A second live thread is refused; once the first is released, a new one is allowed.
      await expect(insertThread()).rejects.toThrow(/chat_threads_one_live_per_request_idx/);
      await pool.query(`UPDATE chat_threads SET released_at = now() WHERE chat_thread_id = $1`, [
        threadId,
      ]);
      await insertThread();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('0021 resource contacts and area', () => {
  /** A migrations directory holding only versions 1 to 20, to build the old shape first. */
  async function migrationsUpTo20(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'suas-migrations-'));
    const source = resolveMigrationsDir();
    for (const name of await readdir(source)) {
      if (/^\d{4}_/.test(name) && Number.parseInt(name.slice(0, 4), 10) <= 20) {
        await cp(join(source, name), join(dir, name));
      }
    }
    return dir;
  }

  it('backfills the list from the single contact and bounds the list and the area', async () => {
    const dir = await migrationsUpTo20();
    try {
      await runMigrations(pool, {
        mode: 'apply',
        provenance,
        migrationsDir: dir,
        expectedSchemaVersion: 20,
      });

      const tenantId = randomUUID();
      const resource = async (contact: string | null, kind: string | null) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO resources
             (resource_id, tenant_id, service_name, category, contact_method, contact_method_kind)
           VALUES ($1, $2, 'Pantry', 'FOOD', $3, $4)`,
          [id, tenantId, contact, kind],
        );
        return id;
      };
      const draft = async (contact: string | null, kind: string | null) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO resource_drafts
             (resource_draft_id, tenant_id, source_url, service_name, category,
              contact_method, contact_method_kind)
           VALUES ($1, $2, 'https://source.example.invalid', 'Pantry', 'FOOD', $3, $4)`,
          [id, tenantId, contact, kind],
        );
        return id;
      };
      const withKind = await resource('408-555-0100', 'PHONE');
      const noKind = await resource('front desk', null);
      const noContact = await resource(null, null);
      const draftWithKind = await draft('help@pantry.example.invalid', 'EMAIL');
      const draftNoContact = await draft(null, null);

      const result = await runMigrations(pool, { mode: 'apply', provenance });
      expect(result.appliedNow).toEqual([21]);
      expect(await readSchemaVersion(pool)).toBe(EXPECTED_SCHEMA_VERSION);

      const read = async (table: string, key: string, id: string) => {
        const row = await pool.query<{ contacts: unknown; area: string | null }>(
          `SELECT contacts, area FROM ${table} WHERE ${key} = $1`,
          [id],
        );
        return row.rows[0];
      };
      expect(await read('resources', 'resource_id', withKind)).toEqual({
        contacts: [{ kind: 'PHONE', value: '408-555-0100' }],
        area: null,
      });
      expect((await read('resources', 'resource_id', noKind))?.contacts).toEqual([
        { kind: 'FREEFORM', value: 'front desk' },
      ]);
      expect((await read('resources', 'resource_id', noContact))?.contacts).toEqual([]);
      expect((await read('resource_drafts', 'resource_draft_id', draftWithKind))?.contacts).toEqual(
        [{ kind: 'EMAIL', value: 'help@pantry.example.invalid' }],
      );
      expect(
        (await read('resource_drafts', 'resource_draft_id', draftNoContact))?.contacts,
      ).toEqual([]);

      const entry = (n: number) => ({ kind: 'PHONE', value: `408-555-010${n}` });
      const setContacts = (table: string, key: string, id: string, value: unknown) =>
        pool.query(`UPDATE ${table} SET contacts = $2::jsonb WHERE ${key} = $1`, [
          id,
          JSON.stringify(value),
        ]);
      const setArea = (table: string, key: string, id: string, area: string) =>
        pool.query(`UPDATE ${table} SET area = $2 WHERE ${key} = $1`, [id, area]);

      for (const [table, key, id] of [
        ['resources', 'resource_id', withKind],
        ['resource_drafts', 'resource_draft_id', draftWithKind],
      ] as const) {
        await setContacts(table, key, id, [entry(1), entry(2), entry(3)]);
        await expect(setContacts(table, key, id, [1, 2, 3, 4].map(entry))).rejects.toThrow(
          /_contacts_check/,
        );
        await expect(setContacts(table, key, id, { kind: 'PHONE' })).rejects.toThrow(
          /_contacts_check/,
        );
        await setArea(table, key, id, 'x'.repeat(80));
        await expect(setArea(table, key, id, 'x'.repeat(81))).rejects.toThrow(/_area_check/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('previous baseline versus this build', () => {
  // migrations/ at 823fc7e5b2933ec0e045e397ad747507e9b805fd, vendored so a
  // depth-1 checkout (actions/checkout default) still has the bytes. git
  // ls-tree of that commit fails there with "fatal: not a tree object".
  const previousBaselineDir = fileURLToPath(
    new URL('../fixtures/old-baseline-823fc7e/migrations', import.meta.url),
  );

  it('stops with SchemaStateError when 0001-0014 from that baseline are already applied, and does not drop the schema', async () => {
    const fileNames = (await readdir(previousBaselineDir))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(fileNames).toEqual([
      '0001_baseline.sql',
      '0002_event_idempotency_kernel.sql',
      '0003_identity_tenancy.sql',
      '0004_consent_privacy.sql',
      '0005_coordination.sql',
      '0006_followup_settlement.sql',
      '0007_resources_fulfillment.sql',
      '0008_notifications.sql',
      '0009_checkins_signals.sql',
      '0010_notification_subject.sql',
      '0011_resource_contact_method_kind.sql',
      '0012_job_outbox.sql',
      '0013_pilot_data_operations.sql',
      '0014_va_sandbox_oauth_evidence.sql',
    ]);
    await ensureMigrationsTable(pool);
    for (const fileName of fileNames) {
      const sql = await readFile(join(previousBaselineDir, fileName), 'utf8');
      await pool.query(sql);
      const match = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(fileName);
      if (match === null) throw new Error(`unexpected migration name ${fileName}`);
      await pool.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum) VALUES ($1, $2, $3)`,
        [Number(match[1]), match[2], checksumOf(sql)],
      );
    }
    await pool.query('CREATE TABLE public.old_baseline_sentinel (id int)');

    const refusal = runMigrations(pool, { mode: 'apply', provenance });
    await expect(refusal).rejects.toBeInstanceOf(SchemaStateError);
    await expect(refusal).rejects.toThrow(/modified after it was applied/);
    const sentinel = await pool.query<{ present: string | null }>(
      `SELECT to_regclass('public.old_baseline_sentinel') AS present`,
    );
    expect(sentinel.rows[0]?.present).not.toBeNull();
  });
});
