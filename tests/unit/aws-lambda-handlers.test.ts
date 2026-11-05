/**
 * The scheduled job-worker and migrate Lambda handlers (V1_PROJECT_PLAN.md §4.1).
 * The worker loop, the migrator and the pool are replaced, so no database is touched.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validEnv } from '../helpers/env.js';

const end = vi.fn(() => Promise.resolve());
const runJobWorker = vi.fn((_options: unknown) => Promise.resolve());
const runMigrations = vi.fn((_pool: unknown, _options: unknown) =>
  Promise.resolve({
    mode: 'apply',
    schemaVersion: 3,
    expectedSchemaVersion: 3,
    appliedNow: [],
    specStackDrift: false,
  }),
);

vi.mock('../../src/db/index.js', () => ({ createPool: () => ({ end }) }));
vi.mock('../../src/jobs/worker.js', () => ({ runJobWorker }));
vi.mock('../../src/db/migrator.js', () => ({ runMigrations }));

const { handler: jobWorker } = await import('../../src/aws/job-worker-lambda.js');
const { handler: migrate } = await import('../../src/aws/migrate-lambda.js');

beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(validEnv())) {
    if (value !== undefined) vi.stubEnv(key, value);
  }
});

describe('job worker Lambda', () => {
  it('runs one pass, not the polling loop, and always closes the pool', async () => {
    await expect(jobWorker({}, { awsRequestId: 'req-1' })).resolves.toEqual({ passes: 1 });
    expect(runJobWorker).toHaveBeenCalledOnce();
    expect(runJobWorker.mock.calls[0]?.[0]).toMatchObject({ once: true, limit: 10 });
    expect(end).toHaveBeenCalledOnce();
  });

  it('takes a valid batch size from the event and ignores an invalid one', async () => {
    await jobWorker({ limit: 25 });
    await jobWorker({ limit: -1 });
    expect(runJobWorker.mock.calls.map((call) => (call[0] as { limit: number }).limit)).toEqual([
      25, 10,
    ]);
  });

  it('fails the invocation when the worker throws', async () => {
    runJobWorker.mockRejectedValueOnce(new Error('database unreachable'));
    await expect(jobWorker({})).rejects.toThrow('database unreachable');
    expect(end).toHaveBeenCalledOnce();
  });
});

describe('migrate Lambda', () => {
  it('applies migrations whatever SUAS_MIGRATIONS_MODE says and reports versions only', async () => {
    vi.stubEnv('SUAS_MIGRATIONS_MODE', 'validate');
    const result = await migrate();
    expect(runMigrations.mock.calls[0]?.[1]).toMatchObject({ mode: 'apply' });
    expect(result).toMatchObject({ mode: 'apply', schema_version: 3, spec_stack_drift: false });
    expect(JSON.stringify(result)).not.toContain('postgres');
    expect(end).toHaveBeenCalledOnce();
  });

  it('fails the invocation when a migration fails', async () => {
    runMigrations.mockRejectedValueOnce(new Error('migration 0003 failed'));
    await expect(migrate()).rejects.toThrow('migration 0003 failed');
    expect(end).toHaveBeenCalledOnce();
  });
});
