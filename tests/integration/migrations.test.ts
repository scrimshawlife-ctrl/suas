/**
 * Migration harness integration evidence (requires PostgreSQL).
 *
 * SUAS-specs ENVIRONMENT.md §3 "Data / persistence", §5, §9;
 * SUAS-specs VERSIONING.md §3.5;
 * SUAS-specs TESTING.md §2 "Migration/restore" layer.
 */

import { isIP } from 'node:net';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AMBIENT_SESSION_ENV_KEYS } from '../../src/config/ambient-connection.js';
import {
  databaseNameFromUrl,
  EXPECTED_SCHEMA_VERSION,
  loadMigrationFiles,
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
