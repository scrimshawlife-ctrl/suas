/**
 * Check-In HTTP surface (requires PostgreSQL).
 *
 * SUAS-specs API.md §3 / §8; CHECKINS.md §4-§6.
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

async function veteranSession() {
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
  return { tenantId, user, headers: { authorization: `Bearer ${session.credential}` } };
}

describe('POST /api/v0/check-ins', () => {
  it('starts a Check-In on qv-001 and returns questions', async () => {
    const { headers } = await veteranSession();
    const response = await app.server.inject({
      method: 'POST',
      url: '/api/v0/check-ins',
      headers,
    });
    expect(response.statusCode).toBe(201);
    const body: {
      check_in_id: string;
      questionnaire_version: string;
      status: string;
      questions: { question_key: string; required: boolean; options: { option_key: string }[] }[];
    } = response.json();
    expect(body.questionnaire_version).toBe('qv-001');
    expect(body.status).toBe('STARTED');
    expect(body.questions.some((question) => question.question_key === 'safe_now')).toBe(true);
    expect(body.questions.every((question) => question.options.length > 0)).toBe(true);
  });

  it('refuses an unauthenticated start', async () => {
    const response = await app.server.inject({ method: 'POST', url: '/api/v0/check-ins' });
    expect(response.statusCode).toBe(401);
  });
});

describe('Check-In answer and complete', () => {
  async function startOwned() {
    const session = await veteranSession();
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/v0/check-ins',
      headers: session.headers,
    });
    expect(started.statusCode).toBe(201);
    const body: { check_in_id: string; questions: QuestionJson[] } = started.json();
    return { session, body };
  }

  interface QuestionJson {
    question_id: string;
    question_key: string;
    required: boolean;
    options: { answer_option_id: string; option_key: string }[];
  }

  async function answerAll(
    headers: { authorization: string },
    checkInId: string,
    questions: QuestionJson[],
    answers: Readonly<Record<string, string>>,
  ) {
    for (const question of questions) {
      const optionKey = answers[question.question_key];
      if (optionKey === undefined) continue;
      const option = question.options.find((entry) => entry.option_key === optionKey);
      if (option === undefined) throw new Error(`missing ${optionKey}`);
      const saved = await app.server.inject({
        method: 'POST',
        url: `/api/v0/check-ins/${checkInId}/responses`,
        headers,
        payload: { question_id: question.question_id, answer_option_id: option.answer_option_id },
      });
      expect(saved.statusCode).toBe(200);
    }
  }

  it("hides another veteran's Check-In", async () => {
    const first = await startOwned();
    const stranger = await veteranSession();
    const response = await app.server.inject({
      method: 'GET',
      url: `/api/v0/check-ins/${first.body.check_in_id}`,
      headers: stranger.headers,
    });
    expect(response.statusCode).toBe(404);
  });

  it('settles GREEN without opening a case', async () => {
    const { session, body } = await startOwned();
    await answerAll(session.headers, body.check_in_id, body.questions, A0);
    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
      headers: session.headers,
    });
    expect(completed.statusCode).toBe(200);
    const result: {
      status: string;
      support_signal: { level: string } | null;
      support_case: { case_id: string } | null;
    } = completed.json();
    expect(result.status).toBe('COMPLETED');
    expect(result.support_signal?.level).toBe('GREEN');
    expect(result.support_case).toBeNull();
  });

  it('opens a RED case from GV-007 answers', async () => {
    const { session, body } = await startOwned();
    await answerAll(session.headers, body.check_in_id, body.questions, {
      ...A0,
      safe_now: 'NO_IMMEDIATE_HELP',
    });
    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
      headers: session.headers,
    });
    expect(completed.statusCode).toBe(200);
    const result: {
      support_signal: { level: string } | null;
      support_case: { status: string; priority_signal_level: string | null } | null;
    } = completed.json();
    expect(result.support_signal?.level).toBe('RED');
    expect(result.support_case?.status).toBe('OPEN');
    expect(result.support_case?.priority_signal_level).toBe('RED');
  });
});
