/**
 * Veteran self status projection (requires PostgreSQL).
 *
 * SUAS-specs APIS.md §2.1; API.md §4; MVP_REFERENCE.md §5–§7.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createUser } from '../../src/identity/index.js';
import { ensurePublishedQv001 } from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

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

const A0: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};

interface QuestionJson {
  question_id: string;
  question_key: string;
  options: { answer_option_id: string; option_key: string }[];
}

describe('GET /api/v0/veterans/me', () => {
  it('requires authentication', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/veterans/me' });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('projects enrollment, categories, and empty coordination state', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/veterans/me',
      headers: { authorization: `Bearer ${session.credential}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      user_id: user.userId,
      status: 'ACTIVE',
      enrolled_channels: { email: true, phone: false },
      open_case: null,
      active_qrf: null,
    });
    expect(body).not.toHaveProperty('email');
    expect(body).not.toHaveProperty('phone');
    expect(body.categories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'Food',
          disposition: 'OPERATIONAL',
          category: 'FOOD',
        }),
        expect.objectContaining({
          label: 'Counseling',
          disposition: 'COMING_SOON',
          category: null,
        }),
      ]),
    );
  });

  it('includes an open RED case after Check-In completion', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const user = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await ensurePublishedQv001(pool, user.userId);
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    const headers = { authorization: `Bearer ${session.credential}` };

    const started = await app.server.inject({
      method: 'POST',
      url: '/api/v0/check-ins',
      headers,
    });
    expect(started.statusCode).toBe(201);
    const checkIn: { check_in_id: string; questions: QuestionJson[] } = started.json();
    for (const question of checkIn.questions) {
      const optionKey =
        question.question_key === 'safe_now' ? 'NO_IMMEDIATE_HELP' : A0[question.question_key];
      if (optionKey === undefined) continue;
      const option = question.options.find((entry) => entry.option_key === optionKey);
      if (option === undefined) throw new Error(`missing ${optionKey}`);
      const saved = await app.server.inject({
        method: 'POST',
        url: `/api/v0/check-ins/${checkIn.check_in_id}/responses`,
        headers,
        payload: {
          question_id: question.question_id,
          answer_option_id: option.answer_option_id,
        },
      });
      expect(saved.statusCode).toBe(200);
    }
    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${checkIn.check_in_id}/commands/complete`,
      headers,
    });
    expect(completed.statusCode).toBe(200);

    const me = await app.server.inject({
      method: 'GET',
      url: '/api/v0/veterans/me',
      headers,
    });
    expect(me.statusCode).toBe(200);
    const body = me.json();
    expect(body.open_case).toMatchObject({
      status: 'OPEN',
      priority_signal_level: 'RED',
    });
    expect(body.open_case.case_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });
});
