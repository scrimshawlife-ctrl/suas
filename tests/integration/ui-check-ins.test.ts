/**
 * Veteran Check-In HTML loop (requires PostgreSQL).
 *
 * SUAS-specs CHECKINS.md §4-§6, §8; API.md §4 / §8; SAFETY.md §3.2;
 * AUTH.md §5 (same session gate as GET); ENVIRONMENT.md §3 (fixture mode).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { findNonClosedCase } from '../../src/coordination/index.js';
import { createUser } from '../../src/identity/index.js';
import {
  ensurePublishedQv001,
  findCheckIn,
  listQuestionsWithOptions,
} from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { auditAccessibility } from '../../src/ui/index.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }), listen: false });
});

afterAll(async () => {
  await app.close();
});

function pool() {
  const value = app.pool;
  if (value === undefined) throw new Error('The test app has no database pool.');
  return value;
}

function authorized(credential: string) {
  return { authorization: `Bearer ${credential}` };
}

const A0: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};

async function veteranSession(): Promise<{
  credential: string;
  tenantId: string;
  userId: string;
}> {
  const tenantId = randomUUID();
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await ensurePublishedQv001(pool(), user.userId);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return { credential: session.credential, tenantId, userId: user.userId };
}

async function startHtmlCheckIn(credential: string): Promise<string> {
  const response = await app.server.inject({
    method: 'POST',
    url: '/app/check-ins',
    headers: authorized(credential),
  });
  expect(response.statusCode).toBe(303);
  const location = response.headers.location;
  if (typeof location !== 'string') throw new Error('expected a Check-In Location');
  const match = /\/app\/check-ins\/([0-9a-f-]{36})$/i.exec(location);
  if (match?.[1] === undefined) throw new Error(`unexpected Location: ${location}`);
  return match[1];
}

async function answerRequired(
  credential: string,
  tenantId: string,
  checkInId: string,
  answers: Readonly<Record<string, string>> = A0,
): Promise<void> {
  const checkIn = await findCheckIn(pool(), tenantId, checkInId);
  if (checkIn === undefined) throw new Error('expected an owned Check-In');
  const questions = await listQuestionsWithOptions(pool(), checkIn.questionnaireVersion);
  for (const question of questions) {
    if (!question.required) continue;
    const optionKey = answers[question.questionKey];
    if (optionKey === undefined) continue;
    const option = question.options.find((entry) => entry.optionKey === optionKey);
    if (option === undefined) throw new Error(`missing ${optionKey}`);
    const saved = await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/responses`,
      headers: {
        ...authorized(credential),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: new URLSearchParams({
        question_id: question.questionId,
        answer_option_id: option.answerOptionId,
      }).toString(),
    });
    expect(saved.statusCode).toBe(303);
    expect(saved.headers.location).toBe(`/app/check-ins/${checkInId}`);
  }
}

async function countCheckIns(tenantId: string, userId: string): Promise<number> {
  const result = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM check_ins
      WHERE tenant_id = $1 AND veteran_user_id = $2`,
    [tenantId, userId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

async function countSignals(tenantId: string, userId: string): Promise<number> {
  const result = await pool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM support_signals
      WHERE tenant_id = $1 AND veteran_user_id = $2`,
    [tenantId, userId],
  );
  return Number(result.rows[0]?.n ?? '0');
}

describe('Check-In HTML — session gate', () => {
  it.each([
    ['GET', '/app/check-ins'],
    ['POST', '/app/check-ins'],
    ['GET', `/app/check-ins/${randomUUID()}`],
    ['POST', `/app/check-ins/${randomUUID()}/responses`],
    ['POST', `/app/check-ins/${randomUUID()}/commands/complete`],
  ] as const)('refuses unauthenticated %s %s', async (method, url) => {
    const response = await app.server.inject({ method, url });
    expect(response.statusCode).toBe(401);
  });
});

describe('Check-In HTML — start, answer, complete', () => {
  it('lets a signed-in veteran finish qv-001 and shows a truthful GREEN result', async () => {
    const { credential, tenantId, userId } = await veteranSession();

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('Start a Check-In');
    expect(home.body).toContain('href="/app/check-ins"');
    expect(home.body).toContain('not a clinical score');

    const checkInId = await startHtmlCheckIn(credential);
    const started = await app.server.inject({
      method: 'GET',
      url: `/app/check-ins/${checkInId}`,
      headers: authorized(credential),
    });
    expect(started.statusCode).toBe(200);
    expect(started.headers['content-type']).toContain('text/html');
    expect(started.body).toContain('qv-001');
    expect(started.body).toContain('Save answer');
    expect(auditAccessibility(started.body)).toEqual([]);

    await answerRequired(credential, tenantId, checkInId, A0);

    const completed = await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/commands/complete`,
      headers: authorized(credential),
    });
    expect(completed.statusCode).toBe(303);
    expect(completed.headers.location).toBe(`/app/check-ins/${checkInId}`);

    const result = await app.server.inject({
      method: 'GET',
      url: `/app/check-ins/${checkInId}`,
      headers: authorized(credential),
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toContain('COMPLETED');
    expect(result.body).toContain('Check-In complete.');
    expect(result.body).toContain('GREEN');
    expect(result.body).toContain('not a clinical score');
    expect(result.body).toContain('did not contact emergency services');
    expect(result.body).not.toContain('A Support Case was opened');
    expect(result.body).not.toContain('Save answer');
    const main = /<main[\s\S]*<\/main>/.exec(result.body)?.[0] ?? '';
    expect(main.toLowerCase()).not.toContain('transition');
    expect(await findNonClosedCase(pool(), tenantId, userId)).toBeUndefined();
    expect(auditAccessibility(result.body)).toEqual([]);
  });

  it('resumes an in-progress Check-In instead of starting a second one', async () => {
    const { credential, tenantId, userId } = await veteranSession();
    const first = await startHtmlCheckIn(credential);
    const second = await startHtmlCheckIn(credential);
    expect(second).toBe(first);
    expect(await countCheckIns(tenantId, userId)).toBe(1);

    const home = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(home.body).toContain('Continue Check-In');
    expect(home.body).toContain(`/app/check-ins/${first}`);
  });

  it("hides another veteran's Check-In", async () => {
    const owner = await veteranSession();
    const checkInId = await startHtmlCheckIn(owner.credential);
    const stranger = await veteranSession();

    const response = await app.server.inject({
      method: 'GET',
      url: `/app/check-ins/${checkInId}`,
      headers: authorized(stranger.credential),
    });
    expect(response.statusCode).toBe(404);

    const posted = await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/commands/complete`,
      headers: authorized(stranger.credential),
    });
    expect(posted.statusCode).toBe(404);
  });

  it('marks an incomplete complete as INCOMPLETE and computes no signal', async () => {
    const { credential, tenantId, userId } = await veteranSession();
    const checkInId = await startHtmlCheckIn(credential);

    const completed = await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/commands/complete`,
      headers: authorized(credential),
    });
    expect(completed.statusCode).toBe(303);

    const result = await app.server.inject({
      method: 'GET',
      url: `/app/check-ins/${checkInId}`,
      headers: authorized(credential),
    });
    expect(result.body).toContain('INCOMPLETE');
    expect(result.body).toContain('This Check-In is incomplete.');
    expect(result.body).toContain('No Support Signal was computed');
    expect(await countSignals(tenantId, userId)).toBe(0);
    expect(await findCheckIn(pool(), tenantId, checkInId)).toMatchObject({ status: 'INCOMPLETE' });
  });

  it('treats an already-completed replay as a no-op', async () => {
    const { credential, tenantId, userId } = await veteranSession();
    const checkInId = await startHtmlCheckIn(credential);
    await answerRequired(credential, tenantId, checkInId, A0);
    await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/commands/complete`,
      headers: authorized(credential),
    });
    expect(await countSignals(tenantId, userId)).toBe(1);

    const replay = await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/commands/complete`,
      headers: authorized(credential),
    });
    expect(replay.statusCode).toBe(303);
    expect(replay.headers.location).toBe(`/app/check-ins/${checkInId}`);
    expect(await countSignals(tenantId, userId)).toBe(1);
    expect(await findCheckIn(pool(), tenantId, checkInId)).toMatchObject({ status: 'COMPLETED' });
  });

  it('mentions a Support Case on a RED result without claiming emergency contact', async () => {
    const { credential, tenantId, userId } = await veteranSession();
    const checkInId = await startHtmlCheckIn(credential);
    await answerRequired(credential, tenantId, checkInId, {
      ...A0,
      safe_now: 'NO_IMMEDIATE_HELP',
    });
    await app.server.inject({
      method: 'POST',
      url: `/app/check-ins/${checkInId}/commands/complete`,
      headers: authorized(credential),
    });

    const result = await app.server.inject({
      method: 'GET',
      url: `/app/check-ins/${checkInId}`,
      headers: authorized(credential),
    });
    expect(result.body).toContain('RED');
    expect(result.body).toContain('A Support Case was opened');
    expect(result.body).toContain('did not contact emergency services');
    expect(result.body).toContain('not a clinical score');
    const supportCase = await findNonClosedCase(pool(), tenantId, userId);
    expect(supportCase?.prioritySignalLevel).toBe('RED');
  });
});
