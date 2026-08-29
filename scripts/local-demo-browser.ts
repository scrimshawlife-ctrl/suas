/**
 * Open one authenticated LOCAL HTML surface in a visible Chromium window.
 *
 * Security boundary:
 * - LOCAL only, loopback only, and never a bearer in a URL.
 * - Credentials come from the process environment or the protected ignored
 *   `.local-secrets/seed-output.json` file.
 * - The Authorization header is scoped to this Playwright browser context.
 *
 * Spec citations: SUAS-specs ENVIRONMENT.md §2, §5-§7; API.md §4;
 * AUTH.md §5; MVP_REFERENCE.md §5.
 */

import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const ROLES = ['veteran', 'responder', 'admin'] as const;
type DemoRole = (typeof ROLES)[number];

const ROLE_CONFIG: Record<DemoRole, { envName: string; path: string }> = {
  veteran: { envName: 'SUAS_E2E_VETERAN_BEARER', path: '/app/home' },
  responder: { envName: 'SUAS_E2E_RESPONDER_BEARER', path: '/app/responder' },
  admin: { envName: 'SUAS_E2E_ADMIN_BEARER', path: '/app/admin' },
};

interface SeedSessions {
  sessions?: {
    veteranBearer?: unknown;
    responderBearer?: unknown;
    adminBearer?: unknown;
  };
}

function fail(message: string): never {
  throw new Error(`Local demo refused: ${message}`);
}

function readRole(): DemoRole {
  const value = process.argv[2];
  if (!ROLES.includes(value as DemoRole)) {
    fail(`role must be one of ${ROLES.join(', ')}.`);
  }
  return value as DemoRole;
}

function localBaseUrl(): URL {
  const raw = process.env.SUAS_LOCAL_BASE_URL ?? 'http://127.0.0.1:3000';
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    fail('SUAS_LOCAL_BASE_URL must be an absolute loopback HTTP URL.');
  }
  if (
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(base.hostname) ||
    base.username !== '' ||
    base.password !== ''
  ) {
    fail('the browser launcher accepts only http://127.0.0.1 or http://localhost.');
  }
  return base;
}

async function readSeedCredential(role: DemoRole): Promise<string> {
  const config = ROLE_CONFIG[role];
  const fromEnvironment = process.env[config.envName]?.trim();
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment;

  const filePath = resolve('.local-secrets/seed-output.json');
  let fileMode: number | undefined;
  try {
    fileMode = (await stat(filePath)).mode;
  } catch {
    fail(
      `${config.envName} is unset and ${filePath} is missing. Run the LOCAL startup workflow first.`,
    );
  }
  // On POSIX, reject a seed file readable by group or other users. Windows
  // ignores POSIX mode bits, but still uses the gitignored path and ACLs.
  if (process.platform !== 'win32' && fileMode !== undefined && (fileMode & 0o077) !== 0) {
    fail(`${filePath} is too broadly readable; chmod 600 it before continuing.`);
  }

  let parsed: SeedSessions;
  try {
    const { readFile } = await import('node:fs/promises');
    parsed = JSON.parse(await readFile(filePath, 'utf8')) as SeedSessions;
  } catch {
    fail(`${filePath} is not valid seed output.`);
  }
  const key =
    role === 'veteran' ? 'veteranBearer' : role === 'responder' ? 'responderBearer' : 'adminBearer';
  const credential = parsed.sessions?.[key];
  if (typeof credential !== 'string' || credential.length < 32) {
    fail(`the selected synthetic ${role} credential is missing from ${filePath}.`);
  }
  return credential;
}

async function main(): Promise<void> {
  if (process.env.SUAS_ENV !== 'LOCAL') {
    fail('SUAS_ENV must be exactly LOCAL.');
  }
  const role = readRole();
  const base = localBaseUrl();
  const credential = await readSeedCredential(role);
  const health = await fetch(new URL('/api/v0/health', base));
  if (!health.ok) fail(`the local runtime health check returned HTTP ${health.status}.`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    extraHTTPHeaders: { Authorization: `Bearer ${credential}` },
  });
  const page = await context.newPage();
  const target = new URL(ROLE_CONFIG[role].path, base);
  const response = await page.goto(target.toString(), { waitUntil: 'domcontentloaded' });
  if (response === null || response.status() >= 400) {
    await browser.close();
    fail(`the ${role} HTML surface returned HTTP ${response?.status() ?? 'no response'}.`);
  }

  console.log(`Opened the authenticated ${role} surface. Close the browser window to exit.`);
  await new Promise<void>((resolveDisconnected) =>
    browser.on('disconnected', () => resolveDisconnected()),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Local browser launch failed.');
  process.exitCode = 1;
});
