/**
 * Discovery and checksumming of on-disk migration files.
 *
 * Spec citations:
 * - SUAS-specs ENVIRONMENT.md §9 "Migration and compatibility rules"
 * - SUAS-specs HANDOFF.md §5 "migration directory and schema-version tracking"
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

/**
 * The `migrations/` directory beside this build: the repository root for
 * `src/db` and `dist/db`, or beside a bundle (`./migrations`, which the Lambda
 * package copies next to the entry file). The working directory is not a
 * candidate. If none of the build-relative directories exist, resolution throws
 * rather than loading some other tree.
 *
 * Lazily evaluated, so importing the db barrel touches no file system; callers
 * resolve the on-disk tree the first time they load migrations.
 */
let migrationsDirCache: string | undefined;

export function resolveMigrationsDir(): string {
  migrationsDirCache ??= chooseMigrationsDir([
    fileURLToPath(new URL('../../migrations', import.meta.url)),
    fileURLToPath(new URL('../migrations', import.meta.url)),
    fileURLToPath(new URL('./migrations', import.meta.url)),
  ]);
  return migrationsDirCache;
}

/** First existing directory. Throws when every candidate is missing. */
export function chooseMigrationsDir(candidates: readonly string[]): string {
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `Migration directory not found beside this build. Refusing to use the working directory. ` +
        `Looked in: ${candidates.join(', ')}`,
    );
  }
  return found;
}

/** @deprecated Prefer `resolveMigrationsDir()`. */
export const MIGRATIONS_DIR = {
  [Symbol.toPrimitive]: () => resolveMigrationsDir(),
  toString: () => resolveMigrationsDir(),
  valueOf: () => resolveMigrationsDir(),
} as unknown as string;

const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Stable checksum over normalized content, so line-ending changes are not drift. */
export function checksumOf(sql: string): string {
  const normalized = sql.replace(/\r\n/g, '\n').trimEnd();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/**
 * Read every migration in `dir`, ordered by version.
 * Throws on unparseable file names or duplicate/non-contiguous versions, so a
 * malformed migration set fails closed rather than applying a partial sequence.
 */
export async function loadMigrationFiles(
  dir: string = resolveMigrationsDir(),
): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((entry) => entry.endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const fileName of entries) {
    const match = FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new Error(
        `Migration file "${fileName}" does not match the required NNNN_snake_case_name.sql pattern.`,
      );
    }
    const [, versionText, name] = match as unknown as [string, string, string];
    const sql = await readFile(join(dir, fileName), 'utf8');
    migrations.push({
      version: Number.parseInt(versionText, 10),
      name,
      fileName,
      sql,
      checksum: checksumOf(sql),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Migration versions must start at 1 and be contiguous; expected ${String(expected).padStart(4, '0')} ` +
          `but found "${migration.fileName}".`,
      );
    }
  });

  return migrations;
}
