import { createHmac } from 'node:crypto';

/**
 * Fixed ports, database and URLs for the local end-to-end stack. Everything can be
 * overridden with SUAS_E2E_* variables so another checkout can run beside this one.
 */

const number = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : Number(raw);
};

export const API_PORT = number('SUAS_E2E_API_PORT', 3190);
export const WS_PORT = number('SUAS_E2E_WS_PORT', 3191);
export const WEB_PORT = number('SUAS_E2E_WEB_PORT', 5193);
export const DB_NAME = process.env['SUAS_E2E_DB_NAME'] ?? 'suas_local_e2e';
export const DB_HOST_URL =
  process.env['SUAS_E2E_DB_HOST_URL'] ?? 'postgresql://suas:suas@localhost:5432';

export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const DATABASE_URL = `${DB_HOST_URL}/${DB_NAME}`;
/** The tenant `npm run seed` writes to, and the one browser sign-up creates users in. */
export const TENANT_ID = '00000000-0000-4000-8000-000000000001';

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * The e2e database must be a throwaway LOCAL one: a `suas_local_<name>` database on this
 * machine. Runs when this module loads, so every consumer (stack, helpers, config) is covered.
 */
export function assertDisposableDatabase(): void {
  if (!/^suas_local_[a-z0-9_]+$/.test(DB_NAME)) {
    throw new Error(
      `Refusing database "${DB_NAME}": the e2e stack only uses databases named suas_local_<name>.`,
    );
  }
  let host: URL;
  try {
    host = new URL(DB_HOST_URL);
  } catch {
    throw new Error('SUAS_E2E_DB_HOST_URL is not a valid URL.');
  }
  if (host.protocol !== 'postgres:' && host.protocol !== 'postgresql:') {
    throw new Error(`Refusing database URL with protocol "${host.protocol}".`);
  }
  if (!LOCAL_HOSTNAMES.has(host.hostname)) {
    throw new Error(
      `Refusing database host "${host.hostname}": the e2e stack is LOCAL only (localhost, 127.0.0.1, ::1).`,
    );
  }
  if ((host.pathname !== '' && host.pathname !== '/') || host.search !== '' || host.hash !== '') {
    throw new Error('SUAS_E2E_DB_HOST_URL must be a server address only: no path, query or hash.');
  }
}

assertDisposableDatabase();

/**
 * The LOCAL fake environment for the API, the migrator, the seed and the job worker.
 * The session secret is generated per run by the stack script and never written to disk.
 * The VA fixture needs SUAS_FINGERPRINT_KEY at startup; it is derived from that secret, so
 * every process of one run shares it, and it is never the secret itself.
 */
export function stackEnv(sessionSecret: string): NodeJS.ProcessEnv {
  const fingerprintKey = createHmac('sha256', sessionSecret)
    .update('suas-e2e-fingerprint-key')
    .digest('base64');
  return {
    ...process.env,
    SUAS_ENV: 'LOCAL',
    SUAS_SPEC_VERSION: '0.9.0',
    SUAS_RELEASE_MANIFEST: 'RELEASE_MANIFEST-0.9.0.md',
    SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
    DATABASE_URL,
    DATABASE_SSL_MODE: 'disable',
    SUAS_MIGRATIONS_MODE: 'validate',
    SUAS_SESSION_SECRET: sessionSecret,
    SUAS_BROWSER_AUTH_MODE: 'disabled',
    SUAS_BROWSER_TENANT_ID: TENANT_ID,
    SUAS_SMS_MODE: 'sink',
    SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
    SUAS_SHELTER_ADAPTER_MODE: 'fake',
    SUAS_FOOD_ADAPTER_MODE: 'fake',
    SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
    SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
    SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
    SUAS_DEMO_FIXED_CODE: 'disabled',
    SUAS_EMAIL_MODE: 'fake',
    // A degraded stack sets these to `disabled` to reach the real 503 paths.
    SUAS_ID_VERIFICATION_MODE: process.env['SUAS_E2E_ID_VERIFICATION_MODE'] ?? 'fake',
    SUAS_VA_CONFIRMATION_MODE: 'fixture',
    SUAS_FINGERPRINT_KEY: fingerprintKey,
    SUAS_FINGERPRINT_KEY_ID: 'e2e-k1',
    // Licence fallback (suas-specs #73 R10.1, proposal): the deterministic reader, with images in
    // the API process's memory, so the read runs inline after the submit (no separate worker).
    SUAS_LICENCE_READER_MODE: 'fixture',
    SUAS_OBJECT_STORAGE_MODE: 'fake',
    SUAS_MODEL_INFERENCE_MODE: process.env['SUAS_E2E_MODEL_INFERENCE_MODE'] ?? 'fake',
    SUAS_CHAT_PUSH_MODE: process.env['SUAS_E2E_CHAT_PUSH_MODE'] ?? 'local',
    SUAS_CHAT_LOCAL_WS_PORT: String(WS_PORT),
    // CI keeps placeholder_test_only (AGENTS.md); local runs default to the approved copy.
    SUAS_SAFETY_COPY_MODE: process.env['SUAS_E2E_SAFETY_COPY_MODE'] ?? 'approved',
    SUAS_HTTP_HOST: '127.0.0.1',
    SUAS_HTTP_PORT: String(API_PORT),
    SUAS_LOG_LEVEL: 'warn',
    SUAS_CORS_ALLOWED_ORIGINS: '',
  };
}
