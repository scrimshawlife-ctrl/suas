/**
 * D-053: reset runs only against an allowlisted synthetic disposable database.
 * Checksum refusal stays in the migrator and is covered with the harness tests.
 */

import { describe, expect, it } from 'vitest';
import { planMigrations } from '../../src/db/migrator.js';
import {
  databaseNameFromUrl,
  migrationResetRefusal,
  type MigrationResetPolicy,
} from '../../src/db/migration-reset.js';

const DISPOSABLE_URL = 'postgresql://suas:suas@localhost:5432/suas_migrations_test';

function policy(overrides: Partial<MigrationResetPolicy> = {}): MigrationResetPolicy {
  return {
    environment: 'TEST',
    databaseUrl: DISPOSABLE_URL,
    allowlist: ['suas_migrations_test'],
    syntheticMarker: 'migrations_test',
    ...overrides,
  };
}

describe('migration reset refusal', () => {
  it('allows an allowlisted database whose name contains the marker', () => {
    expect(migrationResetRefusal(policy())).toBeUndefined();
    expect(databaseNameFromUrl(DISPOSABLE_URL)).toBe('suas_migrations_test');
  });

  it('allows the same target when the allowlist entry is the full URL', () => {
    expect(migrationResetRefusal(policy({ allowlist: [DISPOSABLE_URL] }))).toBeUndefined();
  });

  it('refuses an unnamed target', () => {
    expect(migrationResetRefusal(policy({ allowlist: [] }))).toMatch(/unnamed target/);
    expect(migrationResetRefusal(policy({ allowlist: ['   '] }))).toMatch(/unnamed target/);
    expect(migrationResetRefusal(policy({ databaseUrl: undefined }))).toMatch(/DATABASE_URL/);
    expect(migrationResetRefusal(policy({ databaseUrl: 'postgresql://localhost' }))).toMatch(
      /no database name/,
    );
  });

  it('refuses a database that is not on the allowlist', () => {
    expect(
      migrationResetRefusal(
        policy({
          databaseUrl: 'postgresql://suas:suas@localhost:5432/suas_local',
          allowlist: ['suas_migrations_test'],
          syntheticMarker: 'suas',
        }),
      ),
    ).toMatch(/not on SUAS_MIGRATION_RESET_ALLOWLIST/);
  });

  it('refuses a non-synthetic database even when its name is allowlisted', () => {
    expect(
      migrationResetRefusal(
        policy({
          allowlist: ['suas_migrations_test'],
          syntheticMarker: 'synthetic',
        }),
      ),
    ).toMatch(/does not contain the synthetic marker/);
    expect(migrationResetRefusal(policy({ syntheticMarker: undefined }))).toMatch(
      /SYNTHETIC_MARKER/,
    );
    expect(migrationResetRefusal(policy({ syntheticMarker: '   ' }))).toMatch(/SYNTHETIC_MARKER/);
  });

  it('refuses PRODUCTION even when the name and marker match', () => {
    expect(migrationResetRefusal(policy({ environment: 'PRODUCTION' }))).toMatch(/PRODUCTION/);
  });

  it('refuses STAGING even when the name and marker match', () => {
    expect(migrationResetRefusal(policy({ environment: 'STAGING' }))).toMatch(/STAGING/);
  });

  it('refuses a TEST claim when the process SUAS_ENV is STAGING', () => {
    const saved = process.env.SUAS_ENV;
    process.env.SUAS_ENV = 'STAGING';
    try {
      expect(migrationResetRefusal(policy({ environment: 'TEST' }))).toMatch(/SUAS_ENV=STAGING/);
    } finally {
      process.env.SUAS_ENV = saved;
    }
  });

  it('refuses a production-like URL', () => {
    expect(
      migrationResetRefusal(
        policy({
          databaseUrl: 'postgresql://suas:suas@prod-db.example.invalid:5432/suas_migrations_test',
          allowlist: ['suas_migrations_test'],
        }),
      ),
    ).toMatch(/production marker/);
  });

  it('refuses a malformed URL or allowlist entry', () => {
    expect(
      migrationResetRefusal(policy({ databaseUrl: 'http://example.invalid/suas_migrations_test' })),
    ).toMatch(/malformed/);
    expect(
      migrationResetRefusal(policy({ allowlist: ['suas_migrations_test', 'not a name'] })),
    ).toMatch(/allowlist entry is malformed/);
  });
});

describe('checksum refusal', () => {
  it('still reports a migration whose checksum no longer matches the file', () => {
    const plan = planMigrations(
      [
        {
          version: 1,
          name: 'baseline',
          fileName: '0001_baseline.sql',
          checksum: 'file-checksum',
          sql: 'select 1',
        },
      ],
      [
        {
          version: 1,
          name: 'baseline',
          checksum: 'tampered',
          appliedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    );
    expect(plan.drifted).toEqual([{ version: 1, name: 'baseline' }]);
  });
});
