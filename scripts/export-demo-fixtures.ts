/**
 * SUAS demo fixture exporter.
 *
 * Captures the exact `/api/v0` JSON shapes from the LOCAL seeded demo Worker (started with
 * `npm run dev:demo`) and writes one deterministic, synthetic fixture document that the
 * native iOS and Android demo modes load as `contract/demo-fixtures.json`. This keeps the
 * no-server demo modes on real server shapes instead of hand written guesses.
 *
 * Run with: npm run demo:fixtures -- [--out <path>] [baseUrl]
 *
 * The base URL must be loopback (`127.0.0.1`, `localhost`, `::1`): this script only reads a
 * local demo Worker, never staging or production. The `/api/v0/dev/*` code helper used to
 * read the local OTP code is LOCAL-only; it returns 404 on https://suasqrf.com.
 *
 * All captured data is rewritten to synthetic identifiers, example.invalid emails, and the
 * 555-01XX fictitious phone range before anything is written.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEMO_FIXED_CODE, DEMO_FIXED_CODE_DESTINATION } from '../src/auth/demo-fixed-code.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TENANT_ID = '00000000-0000-4000-8000-000000000001';
const DEMO_UUID_PREFIX = 'de000000-0000-4000-8000-';
const FIXED_TIMESTAMP = '2026-01-15T17:00:00.000Z';

const PRIMARY_EMAIL = DEMO_FIXED_CODE_DESTINATION;
const FRESH_EMAIL = 'newvet@example.invalid';

/**
 * Fixed code the no-server native demo modes accept. It is the same code the LOCAL demo
 * Worker issues to demo@example.invalid (SUAS_DEMO_FIXED_CODE=enabled), so one code works
 * everywhere in the demo.
 */
const DEMO_CODE = DEMO_FIXED_CODE;

const NOTE =
  'Synthetic demo fixtures captured from the LOCAL suas demo Worker (npm run dev:demo, then ' +
  'npm run demo:fixtures). No real person, provider, or contact. Emails use example.invalid; ' +
  'phones use 555-0100..555-0199. Identifiers are rewritten to fixed demo UUIDs. Not a ' +
  'contract change: the source of truth is docs/openapi/v0.json in scrimshawlife-ctrl/suas.';

const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const PHONE_PATTERN = /\+?1?[-. ]?\(?\d{3}\)?[-. ]?\d{3}[-. ]?\d{4}/g;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readString(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const value = obj[key];
  return typeof value === 'string' ? value : undefined;
}

function readArray(obj: unknown, key: string): unknown[] {
  if (!isRecord(obj)) {
    throw new Error(`Expected an object containing "${key}", got ${typeof obj}`);
  }
  const value = obj[key];
  if (!Array.isArray(value)) {
    throw new Error(`Expected "${key}" to be an array, got ${typeof value}`);
  }
  return value;
}

/**
 * Spec item 1: accept only a loopback base URL. This script reads a LOCAL demo Worker, so
 * anything that is not 127.0.0.1 / localhost / ::1 is refused outright.
 */
export function assertLoopbackBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Base URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Base URL must use http or https, got: ${url.protocol}`);
  }
  if (!LOOPBACK_HOSTS.includes(url.hostname)) {
    throw new Error(
      `Refusing to read "${url.hostname}": this script only reads the LOCAL demo Worker ` +
        `(npm run dev:demo). Allowed hosts: ${LOOPBACK_HOSTS.join(', ')}.`,
    );
  }
  return url;
}

/**
 * Spec item 6: deterministic identifier rewrite. Every distinct UUID keeps the tenant id
 * unchanged and otherwise becomes de000000-0000-4000-8000-<counter>, assigned in order of
 * first appearance. Every ISO timestamp collapses to FIXED_TIMESTAMP so captures do not
 * churn between runs.
 */
export function rewriteIdentifiers(json: string): string {
  const assigned = new Map<string, string>();
  const withIds = json.replace(UUID_PATTERN, (match) => {
    const key = match.toLowerCase();
    if (key === TENANT_ID) return match;
    const existing = assigned.get(key);
    if (existing !== undefined) return existing;
    const replacement = `${DEMO_UUID_PREFIX}${String(assigned.size + 1).padStart(12, '0')}`;
    assigned.set(key, replacement);
    return replacement;
  });
  return withIds.replace(TIMESTAMP_PATTERN, FIXED_TIMESTAMP);
}

/**
 * Spec item 7: refuse to emit anything that is not obviously synthetic. Checks for leaked
 * session credentials, non example.invalid email domains, and phone numbers outside the
 * 555-01XX fictitious range.
 */
export function assertSyntheticFixture(json: string): void {
  if (json.includes('session_credential')) {
    throw new Error('Fixture contains "session_credential"; refusing to write it.');
  }

  for (const email of json.match(EMAIL_PATTERN) ?? []) {
    const at = email.lastIndexOf('@');
    const domain = at === -1 ? '' : email.slice(at + 1).toLowerCase();
    if (domain !== 'example.invalid') {
      throw new Error(`Fixture contains a non-synthetic email address: ${email}`);
    }
  }

  // Identifiers and timestamps are digit runs, not phone numbers; drop them before the phone scan.
  const scannable = json.replace(UUID_PATTERN, '').replace(TIMESTAMP_PATTERN, '');
  for (const phone of scannable.match(PHONE_PATTERN) ?? []) {
    const digits = phone.replace(/\D/g, '');
    const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    // 10 digit national number, zero based indices: XXX-555-01XX, the 555-01XX range.
    const inRange =
      national.length === 10 && national.slice(3, 6) === '555' && national.slice(6, 8) === '01';
    if (!inRange) {
      throw new Error(`Fixture contains a phone number outside the fictitious range: ${phone}`);
    }
  }
}

interface CliArgs {
  out?: string;
  baseUrl: string;
}

/**
 * `--out <path>` writes the fixture document; otherwise it is printed to stdout.
 * The base URL is the first positional argument, then SUAS_DEMO_BASE_URL, then
 * http://127.0.0.1:3000. `assertLoopbackBaseUrl` rejects anything that is not local.
 */
function parseCliArgs(argv: string[]): CliArgs {
  let out: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--out') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          '--out requires a file path, for example --out contract/demo-fixtures.json',
        );
      }
      out = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('--out=')) {
      const value = arg.slice('--out='.length);
      if (value.length === 0) {
        throw new Error(
          '--out requires a file path, for example --out contract/demo-fixtures.json',
        );
      }
      out = value;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    positionals.push(arg);
  }

  const positionalBase = positionals[0];
  const baseUrl = positionalBase ?? process.env['SUAS_DEMO_BASE_URL'] ?? 'http://127.0.0.1:3000';

  return out === undefined ? { baseUrl } : { out, baseUrl };
}

/**
 * Reads the identifiers written by `npm run dev:demo` into `.local-secrets/demo-seed.json`.
 * Both values are required: without them the demo Worker has not been seeded yet.
 */
function readSeedIds(): { checkInId: string; caseId: string } {
  const seedPath = path.join(ROOT, '.local-secrets', 'demo-seed.json');
  const hint = `Run \`npm run dev:demo\` first so the LOCAL demo Worker seeds ${seedPath}.`;

  let raw: string;
  try {
    raw = readFileSync(seedPath, 'utf8');
  } catch {
    throw new Error(`Could not read ${seedPath}. ${hint}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse ${seedPath} as JSON. ${hint}`);
  }

  const checkInId = readString(parsed, 'checkInId');
  const openCase = isRecord(parsed) ? parsed['openCase'] : undefined;
  const caseId = readString(openCase, 'caseId');

  if (checkInId === undefined || caseId === undefined) {
    throw new Error(`Missing checkInId or openCase.caseId in ${seedPath}. ${hint}`);
  }

  return { checkInId, caseId };
}

/**
 * Thin JSON wrapper over global fetch. POSTs always send a JSON content type and body.
 * Any status other than `opts.expect` throws with the method, path and status.
 */
async function apiJson(
  base: URL,
  method: 'GET' | 'POST',
  apiPath: string,
  opts: { token?: string; body?: unknown; expect: number },
): Promise<unknown> {
  const url = new URL(apiPath, base);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) {
    headers['authorization'] = `Bearer ${opts.token}`;
  }

  const init: RequestInit = { method, headers };
  if (method === 'POST' || opts.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opts.body ?? {});
  }

  const response = await fetch(url, init);
  if (response.status !== opts.expect) {
    throw new Error(
      `${method} ${url.pathname}${url.search} expected ${opts.expect} but got ${response.status}`,
    );
  }

  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  return JSON.parse(text) as unknown;
}

/**
 * Released OTP flow plus the LOCAL-only `/api/v0/dev/last-challenge` helper, which returns 404
 * on any non-local deployment. The code and the session credential are never printed.
 */
async function signIn(base: URL, email: string): Promise<string> {
  await apiJson(base, 'POST', '/api/v0/auth/challenges', {
    body: { destination: email, method: 'EMAIL_OTP' },
    expect: 202,
  });

  // The primary demo account signs in with the fixed LOCAL demo code, exactly as a presenter would.
  const code =
    email === DEMO_FIXED_CODE_DESTINATION ? DEMO_FIXED_CODE : await lastChallengeCode(base, email);

  const verified = await apiJson(base, 'POST', '/api/v0/auth/challenges/commands/verify', {
    body: { destination: email, code },
    expect: 201,
  });
  const token = readString(verified, 'session_credential');
  if (token === undefined) {
    throw new Error('The verify response did not include a session credential.');
  }

  return token;
}

async function lastChallengeCode(base: URL, email: string): Promise<string> {
  const challenge = await apiJson(
    base,
    'GET',
    `/api/v0/dev/last-challenge?destination=${encodeURIComponent(email)}`,
    { expect: 200 },
  );
  const code = readString(challenge, 'code');
  if (code === undefined) {
    throw new Error(
      'The LOCAL dev challenge helper did not return a code. Is `npm run dev:demo` still running?',
    );
  }
  return code;
}

async function logout(base: URL, token: string): Promise<void> {
  await apiJson(base, 'POST', '/api/v0/auth/sessions/commands/logout', {
    token,
    expect: 204,
  });
}

/**
 * Captures every `/api/v0` shape the native demo modes need from the LOCAL seeded demo Worker.
 * Both sessions are always logged out in a `finally`, even when a request throws.
 */
export async function captureFixtures(base: URL): Promise<Record<string, unknown>> {
  const { checkInId, caseId } = readSeedIds();

  const primaryToken = await signIn(base, PRIMARY_EMAIL);
  let freshToken: string | undefined;

  try {
    freshToken = await signIn(base, FRESH_EMAIL);

    const me = await apiJson(base, 'GET', '/api/v0/veterans/me', {
      token: primaryToken,
      expect: 200,
    });
    const serviceRequests = await apiJson(base, 'GET', `/api/v0/cases/${caseId}/service-requests`, {
      token: primaryToken,
      expect: 200,
    });

    const categories = ['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'] as const;
    const resources: unknown[] = [];
    for (const category of categories) {
      const page = await apiJson(base, 'GET', `/api/v0/resources?category=${category}&limit=50`, {
        token: primaryToken,
        expect: 200,
      });
      resources.push(...readArray(page, 'resources'));
    }

    const consents = await apiJson(base, 'GET', '/api/v0/consents', {
      token: primaryToken,
      expect: 200,
    });
    const notifications = await apiJson(base, 'GET', '/api/v0/notifications', {
      token: primaryToken,
      expect: 200,
    });
    const followUps = await apiJson(base, 'GET', `/api/v0/cases/${caseId}/follow-ups`, {
      token: primaryToken,
      expect: 200,
    });
    const immediateResources = await apiJson(base, 'GET', '/api/v0/immediate-resources', {
      token: primaryToken,
      expect: 200,
    });
    const checkIn = await apiJson(base, 'GET', `/api/v0/check-ins/${checkInId}`, {
      token: primaryToken,
      expect: 200,
    });
    const freshMe = await apiJson(base, 'GET', '/api/v0/veterans/me', {
      token: freshToken,
      expect: 200,
    });

    return {
      _note: NOTE,
      spec: '0.6.0',
      tenant_id: TENANT_ID,
      demo_code: DEMO_CODE,
      enrolled: [
        {
          email: PRIMARY_EMAIL,
          me,
          service_requests: readArray(serviceRequests, 'service_requests'),
          follow_ups: readArray(followUps, 'follow_ups'),
        },
        {
          email: FRESH_EMAIL,
          me: freshMe,
          service_requests: [],
          follow_ups: [],
        },
      ],
      resources,
      consents: readArray(consents, 'consents'),
      notifications: readArray(notifications, 'notifications'),
      immediate_resources: immediateResources,
      check_in: checkIn,
    };
  } finally {
    const tokens = [freshToken, primaryToken].filter(
      (token): token is string => token !== undefined,
    );
    await Promise.all(
      tokens.map(async (token) => {
        try {
          await logout(base, token);
        } catch (error) {
          process.stderr.write(
            `Warning: could not log out a demo session: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
      }),
    );
  }
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const base = assertLoopbackBaseUrl(args.baseUrl);

  const doc = await captureFixtures(base);

  const rewritten = rewriteIdentifiers(JSON.stringify(doc));
  assertSyntheticFixture(rewritten);

  const parsed: unknown = JSON.parse(rewritten);
  const output = `${JSON.stringify(parsed, null, 2)}\n`;

  if (args.out === undefined) {
    process.stdout.write(output);
    return;
  }

  const enrolledCount = readArray(parsed, 'enrolled').length;
  const resourceCount = readArray(parsed, 'resources').length;

  const outPath = path.resolve(args.out);
  writeFileSync(outPath, output, 'utf8');
  process.stderr.write(
    `Wrote ${outPath} from ${base.origin}: ${enrolledCount} enrolled profiles, ${resourceCount} resources\n`,
  );
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
