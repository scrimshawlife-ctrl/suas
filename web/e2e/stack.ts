/**
 * Brings the API up from nothing for the end-to-end suite: drops and recreates the
 * LOCAL e2e database, applies migrations, seeds it, then runs the API in the
 * foreground. Playwright's webServer starts this and stops it afterwards.
 *
 * The session secret is random per run and only lives in this process tree's env.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { DATABASE_URL, DB_HOST_URL, DB_NAME, assertDisposableDatabase, stackEnv } from './config';

const repoRoot = resolve(import.meta.dirname, '..', '..');
const env = stackEnv(randomBytes(32).toString('hex'));

async function resetDatabase(): Promise<void> {
  assertDisposableDatabase();
  const admin = new Client({ connectionString: `${DB_HOST_URL}/postgres` });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${DB_NAME}"`);
  } finally {
    await admin.end();
  }
}

function runCli(script: string, args: string[] = []): void {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx/esm', `src/cli/${script}.ts`, ...args],
    // The seed prints session credentials, so its output is discarded.
    { cwd: repoRoot, env, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (result.status !== 0) throw new Error(`${script} failed with status ${String(result.status)}`);
}

await resetDatabase();
console.log(`[e2e] reset ${DATABASE_URL.replace(/\/\/.*@/, '//')}`);
runCli('migrate', ['apply']);
runCli('seed-local');
console.log('[e2e] migrated and seeded; starting the API');

const api = spawn(process.execPath, ['--import', 'tsx/esm', 'src/main.ts'], {
  cwd: repoRoot,
  env,
  stdio: 'inherit',
});
const stop = () => api.kill('SIGTERM');
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
api.on('exit', (code) => process.exit(code ?? 0));
