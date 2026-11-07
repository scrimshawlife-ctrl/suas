/**
 * Migration planning evidence (no database required).
 *
 * SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules".
 */

import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  chooseMigrationsDir,
  EXPECTED_SCHEMA_VERSION,
  loadMigrationFiles,
  planMigrations,
  resolveMigrationsDir,
} from '../../src/db/index.js';
import type { AppliedMigration } from '../../src/db/index.js';

function applied(version: number, name: string, checksum: string): AppliedMigration {
  return { version, name, checksum, appliedAt: new Date('2026-08-18T00:00:00Z') };
}

describe('on-disk migration set', () => {
  it('loads contiguous, well-named migrations', async () => {
    const files = await loadMigrationFiles();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, index) => {
      expect(file.version).toBe(index + 1);
      expect(file.fileName).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    });
  });

  it('refuses a missing build directory instead of using the working directory', () => {
    expect(() =>
      chooseMigrationsDir(['/no/such/suas-migrations-a', '/no/such/suas-migrations-b']),
    ).toThrow(/working directory/);
  });

  it('loads this build migration set through the expected schema version', async () => {
    const files = await loadMigrationFiles(resolveMigrationsDir());
    expect(files.at(-1)?.version).toBe(EXPECTED_SCHEMA_VERSION);
    expect(files.some((file) => file.fileName === '0007_resources_fulfillment.sql')).toBe(true);
    expect(files.some((file) => file.fileName === '0008_notifications.sql')).toBe(true);
    const resources = files.find((file) => file.fileName === '0007_resources_fulfillment.sql');
    const notifications = files.find((file) => file.fileName === '0008_notifications.sql');
    expect(resources?.sql).toContain('resources_contact_method_kind_check');
    expect(resources?.sql).toContain(
      "CHECK (contact_method_kind IN ('PHONE', 'EMAIL', 'URL', 'FREEFORM'))",
    );
    expect(notifications?.sql).toContain('subject_type');
    expect(notifications?.sql).toContain('subject_id');
    expect(notifications?.sql).toContain('notifications_subject_idx');
  });

  it('produces a stable checksum that ignores line-ending changes', () => {
    expect(checksumOf('SELECT 1;\n')).toBe(checksumOf('SELECT 1;\r\n'));
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 2;'));
  });
});

describe('planMigrations', () => {
  const file = {
    version: 1,
    name: 'baseline',
    fileName: '0001_baseline.sql',
    sql: 'SELECT 1;',
    checksum: checksumOf('SELECT 1;'),
  };

  it('reports an unapplied migration as pending', () => {
    const plan = planMigrations([file], []);
    expect(plan.pending).toHaveLength(1);
    expect(plan.drifted).toHaveLength(0);
    expect(plan.orphaned).toHaveLength(0);
  });

  it('reports nothing when history matches the files', () => {
    const plan = planMigrations([file], [applied(1, 'baseline', file.checksum)]);
    expect(plan.pending).toHaveLength(0);
    expect(plan.drifted).toHaveLength(0);
    expect(plan.orphaned).toHaveLength(0);
  });

  it('detects an applied migration that was edited afterwards', () => {
    const plan = planMigrations([file], [applied(1, 'baseline', checksumOf('SELECT 2;'))]);
    expect(plan.drifted).toEqual([{ version: 1, name: 'baseline' }]);
  });

  it('detects a database ahead of the build', () => {
    const plan = planMigrations(
      [file],
      [applied(1, 'baseline', file.checksum), applied(2, 'from_the_future', 'deadbeef')],
    );
    expect(plan.orphaned).toHaveLength(1);
    expect(plan.orphaned[0]?.version).toBe(2);
  });
});
