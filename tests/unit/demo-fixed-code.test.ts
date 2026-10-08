import { describe, expect, it } from 'vitest';

import {
  DEMO_FIXED_CODE,
  DEMO_FIXED_CODE_DESTINATION,
  demoFixedCodeFor,
  isLocalDemoDatabaseUrl,
} from '../../src/auth/demo-fixed-code.js';

const LOCAL_DATABASE_URL = 'postgresql://suas:suas@localhost:5432/suas_demo';

const OTHER_DESTINATIONS: readonly string[] = [
  'newvet@example.invalid',
  'veteran@example.invalid',
  'Demo@example.invalid',
  'demo@example.com',
];

function localProvider(databaseUrl: string | undefined) {
  return demoFixedCodeFor({
    environment: 'LOCAL',
    demoFixedCode: true,
    databaseUrl,
  });
}

describe('demoFixedCodeFor', () => {
  it('returns 123456 for the exact normalized demo destination', () => {
    expect(DEMO_FIXED_CODE).toBe('123456');
    expect(localProvider(LOCAL_DATABASE_URL)?.(DEMO_FIXED_CODE_DESTINATION)).toBe(DEMO_FIXED_CODE);
  });

  it.each(OTHER_DESTINATIONS)('falls back to a random code for %s', (destination) => {
    expect(localProvider(LOCAL_DATABASE_URL)?.(destination)).toBeUndefined();
  });

  it.each([
    'postgresql://suas:suas@127.0.0.1:5432/suas_demo',
    'postgresql://suas:suas@[::1]:5432/suas_demo',
    'postgres://u:p@0123abcd.hyperdrive.local:5432/db',
  ])('accepts the local database %s in LOCAL with the flag', (databaseUrl) => {
    expect(localProvider(databaseUrl)?.(DEMO_FIXED_CODE_DESTINATION)).toBe(DEMO_FIXED_CODE);
  });

  it.each(['PRODUCTION', 'TEST'])('never returns a fixed code in %s', (environment) => {
    const resolve = demoFixedCodeFor({
      environment,
      demoFixedCode: true,
      databaseUrl: LOCAL_DATABASE_URL,
      workerRuntime: true,
    });
    expect(resolve).toBeUndefined();
  });

  it('returns the fixed code for the synthetic STAGING worker', () => {
    const resolve = demoFixedCodeFor({
      environment: 'STAGING',
      demoFixedCode: true,
      databaseUrl: 'postgresql://u:p@db.internal.invalid:5432/x',
      workerRuntime: true,
    });
    expect(resolve?.(DEMO_FIXED_CODE_DESTINATION)).toBe(DEMO_FIXED_CODE);
  });

  it('returns undefined for STAGING when the process is not the worker', () => {
    const resolve = demoFixedCodeFor({
      environment: 'STAGING',
      demoFixedCode: true,
      databaseUrl: LOCAL_DATABASE_URL,
    });
    expect(resolve).toBeUndefined();
  });

  it('returns undefined in LOCAL without the opt in flag', () => {
    const resolve = demoFixedCodeFor({
      environment: 'LOCAL',
      demoFixedCode: false,
      databaseUrl: LOCAL_DATABASE_URL,
    });
    expect(resolve).toBeUndefined();
  });

  it.each([
    undefined,
    'postgresql://u:p@db.internal.invalid:5432/x',
    'postgresql://u:p@10.0.2.2:5432/x',
    'postgresql://u:p@evil-hyperdrive.local.example.com/x',
    'mysql://u:p@localhost/x',
    'not a url',
  ])('returns undefined in LOCAL with the flag and database %s', (databaseUrl) => {
    expect(localProvider(databaseUrl)).toBeUndefined();
  });
});

describe('isLocalDemoDatabaseUrl', () => {
  it.each([
    'postgresql://suas:suas@localhost:5432/suas_demo',
    'postgres://u:p@127.0.0.1:5432/db',
    'postgresql://u:p@[::1]:5432/db',
    'postgres://u:p@0123abcd.hyperdrive.local:5432/db',
  ])('accepts %s', (databaseUrl) => {
    expect(isLocalDemoDatabaseUrl(databaseUrl)).toBe(true);
  });

  it.each([
    undefined,
    'not a url',
    'mysql://u:p@localhost/x',
    'postgresql://u:p@db.internal.invalid:5432/x',
    'postgresql://u:p@10.0.2.2:5432/x',
    'postgresql://u:p@evil-hyperdrive.local.example.com/x',
  ])('rejects %s', (databaseUrl) => {
    expect(isLocalDemoDatabaseUrl(databaseUrl)).toBe(false);
  });
});
