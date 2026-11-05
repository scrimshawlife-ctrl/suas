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

/** The dropped-and-recreated database must be a throwaway LOCAL one. */
export function assertDisposableDatabase(): void {
  if (!/^suas_local_[a-z0-9_]+$/.test(DB_NAME)) {
    throw new Error(
      `Refusing to reset database "${DB_NAME}": the e2e stack only wipes databases named suas_local_<name>.`,
    );
  }
}

/**
 * The LOCAL fake environment for the API, the migrator, the seed and the job worker.
 * The session secret is generated per run by the stack script and never written to disk.
 */
export function stackEnv(sessionSecret: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    SUAS_ENV: 'LOCAL',
    SUAS_SPEC_VERSION: '0.7.0',
    SUAS_RELEASE_MANIFEST: 'RELEASE_MANIFEST-0.7.0.md',
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
    SUAS_ID_VERIFICATION_MODE: 'fake',
    SUAS_MODEL_INFERENCE_MODE: 'fake',
    SUAS_CHAT_PUSH_MODE: 'local',
    SUAS_CHAT_LOCAL_WS_PORT: String(WS_PORT),
    SUAS_SAFETY_COPY_MODE: 'approved',
    SUAS_HTTP_HOST: '127.0.0.1',
    SUAS_HTTP_PORT: String(API_PORT),
    SUAS_LOG_LEVEL: 'warn',
    SUAS_CORS_ALLOWED_ORIGINS: '',
  };
}
