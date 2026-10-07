/**
 * scripts/dev-demo.ts
 *
 * One command (`npm run dev:demo`) that brings up the SUAS Cloudflare Worker LOCALLY with
 * migrations applied and demo seed data loaded.
 *
 * LOCAL only. Everything here is synthetic demo data: emails are @example.invalid and phone
 * numbers are in the fictitious 555-0100..555-0199 range. This script never targets staging
 * (https://suasqrf.com) or any production host, and it refuses any database URL that is not on
 * localhost / 127.0.0.1 / ::1.
 *
 * The `/api/v0/dev/*` routes (for example `GET /api/v0/dev/last-challenge`) exist only because
 * SUAS_ENV=LOCAL; they return 404 when the Worker runs on staging.
 *
 * See SUAS-specs ENVIRONMENT.md section 2 and MOBILE_SURFACE.md (D-033).
 *
 * Usage:
 *   npm run dev:demo
 *   npm run dev:demo -- --reset
 *   npm run dev:demo -- --node --port 3001
 *   npm run dev:demo -- --seed-only
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { SPEC_VERSION, RELEASE_MANIFEST } from '../src/release/pins.js';

const { Client } = pg;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = 'wrangler@4.148.0';
const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const SECRETS_DIR = path.join(ROOT, '.local-secrets');
const DEFAULT_DATABASE_URL = 'postgresql://suas:suas@localhost:5432/suas_demo';
const POSTGRES_CONTAINER = 'suas-postgres17-local';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DATABASE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const RESET_NAME_PREFIX = 'suas_demo';
const SESSION_SECRET_FILE = 'demo-session-secret';
const DEMO_ENV_FILE = 'demo.env';
const SEED_JSON_FILE = 'demo-seed.json';
const POSTGRES_WAIT_SECONDS = 60;

type Flags = {
  node: boolean;
  reset: boolean;
  seedOnly: boolean;
  port: number;
  help: boolean;
};

type DatabaseTarget = {
  url: string;
  databaseName: string;
};

type RunResult = {
  code: number;
  stdout: string;
};

type RunOptions = {
  cwd?: string;
  env?: Record<string, string>;
};

type BannerOptions = {
  runtime: string;
  port: number;
  veteranEmail: string;
  freshVeteranEmail: string;
};

function parseArgs(argv: readonly string[]): Flags {
  const flags: Flags = {
    node: false,
    reset: false,
    seedOnly: false,
    port: 3000,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    switch (arg) {
      case '--node':
        flags.node = true;
        break;
      case '--reset':
        flags.reset = true;
        break;
      case '--seed-only':
        flags.seedOnly = true;
        break;
      case '--help':
        flags.help = true;
        break;
      case '--port': {
        const value = argv[index + 1];
        if (value === undefined) {
          throw new Error('--port requires a value.');
        }
        const parsedPort = Number.parseInt(value, 10);
        if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
          throw new Error(`--port must be an integer between 1 and 65535, received "${value}".`);
        }
        flags.port = parsedPort;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown argument "${arg}". Run with --help for usage.`);
    }
  }

  return flags;
}

function printUsage(): void {
  const lines = [
    'Usage: npm run dev:demo -- [options]',
    '',
    'Brings up the SUAS Worker LOCALLY with migrations applied and demo seed data loaded.',
    'LOCAL only. Synthetic data only. Never targets staging or any production host.',
    '',
    'Options:',
    '  --node            Use the Node runtime (src/main.ts) instead of wrangler dev',
    '  --reset           Drop and recreate the demo database first',
    '  --seed-only       Do everything except starting a server',
    '  --port <n>        Port to listen on (default 3000)',
    '  --help            Show this help',
    '',
    'Environment:',
    '  SUAS_DEMO_DATABASE_URL  Postgres URL, LOCAL only',
    `                          (default ${DEFAULT_DATABASE_URL})`,
    '',
  ];
  console.log(lines.join('\n'));
}

function parseDatabaseUrl(raw: string): DatabaseTarget {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('SUAS_DEMO_DATABASE_URL is not a valid URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `refusing database URL with protocol "${parsed.protocol}": expected "postgres:" or "postgresql:".`,
    );
  }

  if (!LOCAL_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `refusing database host "${parsed.hostname}": dev-demo is LOCAL only (localhost, 127.0.0.1, ::1).`,
    );
  }

  const databaseName = parsed.pathname.replace(/^\//, '');
  if (!DATABASE_NAME_PATTERN.test(databaseName)) {
    throw new Error(
      `refusing database name "${databaseName}": expected ${DATABASE_NAME_PATTERN.source}.`,
    );
  }

  return { url: raw, databaseName };
}

function ensureSessionSecret(): string {
  mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });

  const secretPath = path.join(SECRETS_DIR, SESSION_SECRET_FILE);
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) {
      return existing;
    }
  }

  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, `${secret}\n`, { mode: 0o600 });
  chmodSync(secretPath, 0o600);
  return secret;
}

function buildDemoEnv(
  port: number,
  databaseUrl: string,
  sessionSecret: string,
): Record<string, string> {
  return {
    SUAS_ENV: 'LOCAL',
    // LOCAL demo only: demo@example.invalid always gets the sign-in code 123456. The config
    // rejects this outside SUAS_ENV=LOCAL, and this launcher has already refused any
    // non-loopback database URL.
    SUAS_DEMO_FIXED_CODE: 'enabled',
    SUAS_SPEC_VERSION: SPEC_VERSION,
    SUAS_RELEASE_MANIFEST: RELEASE_MANIFEST,
    SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
    DATABASE_URL: databaseUrl,
    DATABASE_POOL_MAX: '5',
    SUAS_MIGRATIONS_MODE: 'validate',
    SUAS_SESSION_SECRET: sessionSecret,
    SUAS_BROWSER_AUTH_MODE: 'email_otp',
    SUAS_BROWSER_TENANT_ID: TENANT_ID,
    SUAS_EMAIL_MODE: 'fake',
    SUAS_SMS_MODE: 'fake',
    SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
    SUAS_SHELTER_ADAPTER_MODE: 'fake',
    SUAS_FOOD_ADAPTER_MODE: 'fake',
    SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
    SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
    SUAS_SAFETY_COPY_MODE: 'placeholder_test_only',
    SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
    SUAS_HTTP_HOST: '127.0.0.1',
    SUAS_HTTP_PORT: String(port),
    SUAS_LOG_LEVEL: 'info',
    SUAS_VA_SANDBOX_OAUTH_ENABLED: 'false',
  };
}

function buildEnv(demo: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      inherited[key] = value;
    }
  }
  return { ...inherited, ...demo };
}

function writeDemoEnvFile(demo: Record<string, string>): void {
  const lines = [
    '# Generated by scripts/dev-demo.ts (npm run dev:demo). Do not edit by hand.',
    `# The session secret is not written here; it lives in ${SESSION_SECRET_FILE}.`,
  ];
  for (const [key, value] of Object.entries(demo)) {
    if (key === 'SUAS_SESSION_SECRET') {
      continue;
    }
    lines.push(`${key}=${value}`);
  }

  const envPath = path.join(SECRETS_DIR, DEMO_ENV_FILE);
  writeFileSync(envPath, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(envPath, 0o600);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function run(cmd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, [...args], {
      cwd: opts.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts.env !== undefined ? { env: opts.env } : {}),
    });

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', () => {
      // Intentionally discarded: callers only inspect the exit code and stdout.
    });

    child.on('error', () => {
      resolve({ code: 127, stdout });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 127, stdout });
    });
  });
}

function runInherit(
  cmd: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(cmd, [...args], { cwd: ROOT, env, stdio: 'inherit' });
    child.on('error', () => {
      resolve(127);
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

function runCapture(
  cmd: string,
  args: readonly string[],
  env: Record<string, string>,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, [...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'inherit'] });

    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });

    child.on('error', () => {
      resolve({ code: 127, stdout });
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout });
    });
  });
}

async function canConnect(databaseUrl: string): Promise<boolean> {
  const admin = new URL(databaseUrl);
  admin.pathname = '/postgres';

  const client = new Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 3000,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

function printPostgresHelp(): void {
  const lines = [
    'Could not reach a LOCAL Postgres 17 server.',
    '',
    'Pick one of these options and re-run npm run dev:demo:',
    '',
    '  (a) Docker installed and running:',
    '      dev-demo reuses or creates the container',
    `      "${POSTGRES_CONTAINER}" automatically.`,
    '',
    '  (b) Debian/Ubuntu:',
    '      sudo apt-get install postgresql-17',
    `      sudo -u postgres psql -c "CREATE ROLE suas LOGIN PASSWORD 'suas' CREATEDB;"`,
    '',
    '  (c) macOS:',
    '      brew install postgresql@17',
    `      sudo -u postgres psql -c "CREATE ROLE suas LOGIN PASSWORD 'suas' CREATEDB;"`,
    '',
    '  (d) Or point SUAS_DEMO_DATABASE_URL at any LOCAL Postgres 17 with a',
    '      role that can create databases.',
    '',
  ];
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function ensurePostgres(databaseUrl: string): Promise<void> {
  if (await canConnect(databaseUrl)) {
    return;
  }

  const dockerVersion = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (dockerVersion.code !== 0) {
    printPostgresHelp();
    process.exit(1);
  }

  console.log(`Postgres is unreachable, falling back to the Docker container.`);
  const started = await run('docker', ['start', POSTGRES_CONTAINER]);
  if (started.code !== 0) {
    const created = await run('docker', [
      'run',
      '-d',
      '--name',
      POSTGRES_CONTAINER,
      '-e',
      'POSTGRES_USER=suas',
      '-e',
      'POSTGRES_PASSWORD=suas',
      '-e',
      'POSTGRES_DB=suas_local',
      '-p',
      '127.0.0.1:5432:5432',
      'postgres:17',
    ]);
    if (created.code !== 0) {
      printPostgresHelp();
      process.exit(1);
    }
  }

  for (let second = 0; second < POSTGRES_WAIT_SECONDS; second += 1) {
    if (await canConnect(databaseUrl)) {
      return;
    }
    await delay(1000);
  }

  printPostgresHelp();
  process.exit(1);
}

async function ensureDatabase(target: DatabaseTarget, reset: boolean): Promise<void> {
  const admin = new URL(target.url);
  admin.pathname = '/postgres';

  const client = new Client({
    connectionString: admin.toString(),
    connectionTimeoutMillis: 3000,
  });

  await client.connect();
  try {
    if (reset) {
      await client.query(`DROP DATABASE IF EXISTS "${target.databaseName}" WITH (FORCE)`);
    }

    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
      target.databaseName,
    ]);
    if ((existing.rowCount ?? 0) === 0) {
      await client.query(`CREATE DATABASE "${target.databaseName}"`);
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function runMigrationsAndSeed(env: Record<string, string>): Promise<unknown> {
  const applyCode = await runInherit(
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli/migrate.ts', 'apply'],
    env,
  );
  if (applyCode !== 0) {
    process.stderr.write(`migration apply failed (exit ${applyCode}).\n`);
    process.exit(applyCode);
  }

  const validateCode = await runInherit(
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli/migrate.ts', 'validate'],
    env,
  );
  if (validateCode !== 0) {
    process.stderr.write(`migration validate failed (exit ${validateCode}).\n`);
    process.exit(validateCode);
  }

  const seed = await runCapture(
    process.execPath,
    ['--import', 'tsx/esm', 'src/cli/seed-demo.ts'],
    env,
  );
  if (seed.code !== 0) {
    process.stderr.write(`demo seed failed (exit ${seed.code}).\n`);
    process.exit(seed.code);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(seed.stdout);
  } catch {
    throw new Error('could not parse the demo seed stdout as JSON.');
  }

  const seedPath = path.join(SECRETS_DIR, SEED_JSON_FILE);
  writeFileSync(seedPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  chmodSync(seedPath, 0o600);

  return parsed;
}

function readSignInEmail(seed: unknown, key: string, fallback: string): string {
  if (typeof seed !== 'object' || seed === null) {
    return fallback;
  }

  const signIn = (seed as Record<string, unknown>).signIn;
  if (typeof signIn !== 'object' || signIn === null) {
    return fallback;
  }

  const value = (signIn as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  return value;
}

function printBanner(options: BannerOptions): void {
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const lines = [
    '',
    'SUAS local demo',
    '---------------',
    `Runtime:         ${options.runtime}`,
    `Base URL:        ${baseUrl}`,
    `Health:          ${baseUrl}/api/v0/health`,
    `Web app:         ${baseUrl}/app`,
    `Demo sign-in:    ${options.veteranEmail}, code 123456 (LOCAL demo only)`,
    `New veteran:     ${options.freshVeteranEmail} (no case yet)`,
    '',
    'Code for any other account (LOCAL only, this route returns 404 on staging):',
    `  curl "${baseUrl}/api/v0/dev/last-challenge?destination=${options.freshVeteranEmail}"`,
    '',
    `Bearer tokens:    .local-secrets/${SEED_JSON_FILE} (never printed)`,
    `Android emulator: http://10.0.2.2:${options.port}`,
    `iOS simulator:    http://localhost:${options.port}`,
    '',
    'Smoke test: npm run smoke:demo',
    '',
  ];
  console.log(lines.join('\n'));
}

async function startServer(
  flags: Flags,
  env: Record<string, string>,
  databaseUrl: string,
  sessionSecret: string,
): Promise<never> {
  const wranglerArgs = [
    '--yes',
    WRANGLER,
    'dev',
    '--port',
    String(flags.port),
    '--ip',
    '127.0.0.1',
    '--var',
    'SUAS_ENV:LOCAL',
    '--var',
    'SUAS_DEMO_FIXED_CODE:enabled',
    '--var',
    'SUAS_EMAIL_MODE:fake',
    '--var',
    'SUAS_SMS_MODE:fake',
    '--var',
    'SUAS_BROWSER_AUTH_MODE:email_otp',
    '--var',
    `SUAS_BROWSER_TENANT_ID:${TENANT_ID}`,
    '--var',
    `SUAS_SESSION_SECRET:${sessionSecret}`,
  ];

  const cmd = flags.node ? process.execPath : 'npx';
  const args = flags.node ? ['--import', 'tsx/esm', 'src/main.ts'] : wranglerArgs;
  const childEnv = flags.node
    ? env
    : { ...env, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: databaseUrl };

  const code = await new Promise<number>((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: childEnv, stdio: 'inherit' });

    const forwardSigint = (): void => {
      child.kill('SIGINT');
    };
    const forwardSigterm = (): void => {
      child.kill('SIGTERM');
    };
    process.on('SIGINT', forwardSigint);
    process.on('SIGTERM', forwardSigterm);

    child.on('error', () => {
      process.off('SIGINT', forwardSigint);
      process.off('SIGTERM', forwardSigterm);
      resolve(127);
    });
    child.on('close', (exitCode, signal) => {
      process.off('SIGINT', forwardSigint);
      process.off('SIGTERM', forwardSigterm);
      if (exitCode !== null) {
        resolve(exitCode);
        return;
      }
      resolve(signal === 'SIGINT' || signal === 'SIGTERM' ? 0 : 1);
    });
  });

  process.exit(code);
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printUsage();
    return;
  }

  const databaseUrl = process.env.SUAS_DEMO_DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const target = parseDatabaseUrl(databaseUrl);

  if (flags.reset && !target.databaseName.startsWith(RESET_NAME_PREFIX)) {
    throw new Error(
      `refusing --reset for database "${target.databaseName}": the name must start with "${RESET_NAME_PREFIX}".`,
    );
  }

  const sessionSecret = ensureSessionSecret();
  const demo = buildDemoEnv(flags.port, target.url, sessionSecret);
  const env = buildEnv(demo);
  writeDemoEnvFile(demo);

  await ensurePostgres(target.url);
  await ensureDatabase(target, flags.reset);

  const seed = await runMigrationsAndSeed(env);
  const veteranEmail = readSignInEmail(seed, 'veteranEmail', 'demo@example.invalid');
  const freshVeteranEmail = readSignInEmail(seed, 'freshVeteranEmail', 'newvet@example.invalid');

  printBanner({
    runtime: flags.node ? 'Node runtime (src/main.ts)' : 'Cloudflare Worker via wrangler dev',
    port: flags.port,
    veteranEmail,
    freshVeteranEmail,
  });

  if (flags.seedOnly) {
    return;
  }

  await startServer(flags, env, target.url, sessionSecret);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
