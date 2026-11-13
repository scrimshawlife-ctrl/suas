/**
 * Every spec-pin value in deploy and CI configuration must equal src/release/pins.ts.
 *
 * The app fails startup when SUAS_SPEC_VERSION differs from the build pin, so a stale
 * value in a workflow or the env template stays silent until the next run. This
 * reads the files as text (no network) and fails with the file name and the bad value.
 * SUAS-specs ENVIRONMENT.md §3 (SUAS_SPEC_VERSION / SUAS_RELEASE_MANIFEST rules 1-2).
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELEASE_MANIFEST, SPEC_VERSION } from '../../src/release/pins.js';

const ROOT = new URL('../../', import.meta.url).pathname;

/** `KEY: '0.7.0'` (YAML), `KEY=0.7.0 \` (shell), and `"KEY": "0.7.0"` (JSON). */
const PIN_ASSIGNMENT =
  /["']?(SUAS_SPEC_VERSION|SUAS_RELEASE_MANIFEST)["']?[ \t]*[:=][ \t]*["']?([^"'\s,\\]+)/g;

const EXPECTED: Readonly<Record<string, string>> = {
  SUAS_SPEC_VERSION: SPEC_VERSION,
  SUAS_RELEASE_MANIFEST: RELEASE_MANIFEST,
};

/** Files that must carry both pins, so the test cannot pass by matching nothing. */
const REQUIRED_FILES = [
  '.env.example',
  '.github/workflows/verify.yml',
  '.github/workflows/worker-deploy.yml',
  '.github/workflows/staging-acceptance.yml',
  '.github/workflows/staging-migrate.yml',
  '.github/workflows/staging-path-param-check.yml',
  '.github/workflows/staging-recovery-fixtures.yml',
  '.github/workflows/synthetic-staging-soak.yml',
];

function workflowFiles(): string[] {
  return readdirSync(join(ROOT, '.github/workflows'))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => `.github/workflows/${name}`);
}

function pinAssignments(path: string): Array<{ key: string; value: string }> {
  const source = readFileSync(join(ROOT, path), 'utf8');
  return [...source.matchAll(PIN_ASSIGNMENT)].map((match) => ({
    key: match[1] ?? '',
    value: match[2] ?? '',
  }));
}

describe('deploy and CI spec pins match src/release/pins.ts', () => {
  const files = [...new Set([...REQUIRED_FILES, ...workflowFiles()])];

  it.each(files)('%s', (path) => {
    const assignments = pinAssignments(path);
    const wrong = assignments
      .filter(({ key, value }) => value !== EXPECTED[key])
      .map(({ key, value }) => `${key}=${value} (build pin is ${EXPECTED[key]})`);
    expect(wrong, `${path} disagrees with src/release/pins.ts`).toEqual([]);

    if (REQUIRED_FILES.includes(path)) {
      const keys = new Set(assignments.map(({ key }) => key));
      expect([...keys].sort(), `${path} must set both pins`).toEqual([
        'SUAS_RELEASE_MANIFEST',
        'SUAS_SPEC_VERSION',
      ]);
    }
  });
});
