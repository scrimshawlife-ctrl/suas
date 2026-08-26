/**
 * Worker binding → ConfigSource mapping.
 *
 * SUAS-specs ENVIRONMENT.md §3–§6: request-path persistence uses the
 * Hyperdrive pooled URL; apply mode and real external effects stay closed.
 */

import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/index.js';
import { configSourceFromWorkerEnv, type WorkerBindings } from '../../src/worker/env.js';
import { TEST_SESSION_SECRET } from '../helpers/env.js';

const HYPERDRIVE_URL = 'postgresql://hd-user:hd-pass@hyperdrive.example:5432/suas_local';

function workerEnv(overrides: Partial<WorkerBindings> = {}): WorkerBindings {
  return {
    HYPERDRIVE: { connectionString: HYPERDRIVE_URL },
    SUAS_ENV: 'LOCAL',
    SUAS_SPEC_VERSION: '0.2.0',
    SUAS_RELEASE_MANIFEST: 'RELEASE_MANIFEST-0.2.0.md',
    SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'false',
    SUAS_MIGRATIONS_MODE: 'validate',
    SUAS_SESSION_SECRET: TEST_SESSION_SECRET,
    SUAS_EMAIL_MODE: 'sink',
    SUAS_SMS_MODE: 'sink',
    SUAS_TRANSPORTATION_ADAPTER_MODE: 'fake',
    SUAS_SHELTER_ADAPTER_MODE: 'fake',
    SUAS_FOOD_ADAPTER_MODE: 'fake',
    SUAS_PEER_SUPPORT_ADAPTER_MODE: 'manual',
    SUAS_SUPPORT_SIGNAL_MODE: 'fixture',
    SUAS_SAFETY_COPY_MODE: 'placeholder_test_only',
    SUAS_SENSITIVE_AGGREGATE_REPORTING: 'disabled',
    ...overrides,
  };
}

describe('configSourceFromWorkerEnv', () => {
  it('uses the Hyperdrive connection string as DATABASE_URL', () => {
    const source = configSourceFromWorkerEnv(workerEnv());
    expect(source.DATABASE_URL).toBe(HYPERDRIVE_URL);
    const config = loadConfig(source);
    expect(config.database.url).toBe(HYPERDRIVE_URL);
    expect(config.database.migrationsMode).toBe('validate');
  });

  it('ignores a DATABASE_URL Worker secret so the unpooled URL cannot be used', () => {
    const source = configSourceFromWorkerEnv(
      workerEnv({ DATABASE_URL: 'postgresql://direct:unpooled@db.example:5432/suas_local' }),
    );
    expect(source.DATABASE_URL).toBe(HYPERDRIVE_URL);
    expect(source.DATABASE_URL).not.toContain('unpooled');
  });

  it('rejects apply mode instead of applying migrations on the request path', () => {
    expect(() => configSourceFromWorkerEnv(workerEnv({ SUAS_MIGRATIONS_MODE: 'apply' }))).toThrow(
      ConfigurationError,
    );
    try {
      configSourceFromWorkerEnv(workerEnv({ SUAS_MIGRATIONS_MODE: 'apply' }));
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).message).toContain('rejects SUAS_MIGRATIONS_MODE=apply');
      expect((error as ConfigurationError).message).not.toContain('hd-pass');
    }
  });

  it('rejects real external effects', () => {
    expect(() =>
      configSourceFromWorkerEnv(workerEnv({ SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: 'true' })),
    ).toThrow(ConfigurationError);
  });

  it('fails closed without a Hyperdrive binding and does not echo secrets', () => {
    expect(() =>
      configSourceFromWorkerEnv(
        workerEnv({ HYPERDRIVE: undefined, SUAS_SESSION_SECRET: TEST_SESSION_SECRET }),
      ),
    ).toThrow(ConfigurationError);
    try {
      configSourceFromWorkerEnv(workerEnv({ HYPERDRIVE: undefined }));
    } catch (error) {
      expect((error as ConfigurationError).message).not.toContain(TEST_SESSION_SECRET);
      expect((error as ConfigurationError).message).toContain('HYPERDRIVE');
    }
  });

  it('forces validate and false real-effects even when those vars are unset', () => {
    const source = configSourceFromWorkerEnv(
      workerEnv({ SUAS_MIGRATIONS_MODE: undefined, SUAS_ALLOW_REAL_EXTERNAL_EFFECTS: undefined }),
    );
    expect(source.SUAS_MIGRATIONS_MODE).toBe('validate');
    expect(source.SUAS_ALLOW_REAL_EXTERNAL_EFFECTS).toBe('false');
  });
});
