/**
 * An inline job failure logs one `job_failed` line with the error's name and job type, never
 * the error text, which a handler can fill with personal data (A4-07, SECURITY.md §2).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { testDatabaseUrl, validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply', DATABASE_URL: testDatabaseUrl() }),
    listen: false,
  });
});

afterAll(async () => {
  await app.close();
});

it('logs a failed inline job without its error message', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    // A payload notification.send cannot parse makes its handler throw.
    await app.jobQueue.enqueue({
      jobType: 'notification.send',
      payload: { note: 'person@example.invalid' },
      tenantId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const lines = log.mock.calls.map((call) => String(call[0]));
    const line = lines.find((text) => text.includes('job_failed'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({
      level: 'error',
      msg: 'job_failed',
      job_type: 'notification.send',
      type: 'Error',
      message: 'withheld',
    });
    expect(lines.join('\n')).not.toContain('invalid notification.send payload');
  } finally {
    log.mockRestore();
  }
});
