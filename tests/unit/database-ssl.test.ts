/**
 * Database TLS configuration (DATABASE_SSL_MODE, DATABASE_SSL_CA_FILE).
 */

import { describe, expect, it } from 'vitest';
import { loadConfig, tryLoadConfig } from '../../src/config/index.js';
import { databaseSslOptions } from '../../src/db/pool.js';
import { validEnv } from '../helpers/env.js';

function issuesFor(env: Record<string, string | undefined>): readonly string[] {
  const result = tryLoadConfig(validEnv(env));
  expect(result.ok, 'expected configuration to be rejected').toBe(false);
  return result.ok ? [] : result.issues;
}

describe('database TLS configuration', () => {
  it('defaults to no TLS so LOCAL and TEST keep working', () => {
    const { ssl } = loadConfig(validEnv()).database;
    expect(ssl).toEqual({ mode: 'disable', caFile: undefined });
    expect(databaseSslOptions(ssl)).toBeUndefined();
  });

  it('verify mode checks the server certificate and uses the default trust store', () => {
    const { ssl } = loadConfig(validEnv({ DATABASE_SSL_MODE: 'verify' })).database;
    expect(databaseSslOptions(ssl)).toEqual({ rejectUnauthorized: true });
  });

  it('verify mode trusts the CA bundle at the configured path', () => {
    const { ssl } = loadConfig(
      validEnv({ DATABASE_SSL_MODE: 'verify', DATABASE_SSL_CA_FILE: '/var/task/rds-bundle.pem' }),
    ).database;
    const reads: string[] = [];
    const options = databaseSslOptions(ssl, (path) => {
      reads.push(path);
      return 'PEM-BUNDLE';
    });
    expect(options).toEqual({ rejectUnauthorized: true, ca: 'PEM-BUNDLE' });
    expect(reads).toEqual(['/var/task/rds-bundle.pem']);
  });

  it('rejects an unknown mode, since unverified TLS is not offered', () => {
    expect(issuesFor({ DATABASE_SSL_MODE: 'no-verify' }).join('\n')).toMatch(/DATABASE_SSL_MODE/);
  });

  it('rejects a CA file without verify mode', () => {
    expect(issuesFor({ DATABASE_SSL_CA_FILE: '/x.pem' }).join('\n')).toMatch(
      /DATABASE_SSL_CA_FILE requires DATABASE_SSL_MODE=verify/,
    );
  });

  it('rejects ssl parameters in DATABASE_URL that would override verify mode', () => {
    const issues = issuesFor({
      DATABASE_SSL_MODE: 'verify',
      DATABASE_URL: 'postgresql://suas:suas@localhost:5432/suas_test?sslmode=disable',
    });
    expect(issues.join('\n')).toMatch(/must not carry sslmode/);
  });
});
