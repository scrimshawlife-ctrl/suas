/**
 * Check-In HTTP surface (requires PostgreSQL).
 *
 * SUAS-specs API.md §3 / §8; CHECKINS.md §4-§6.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { abandonStaleCheckIns, ensurePublishedQv001 } from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { createVerifiedUser } from '../helpers/verified-veteran.js';

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

/** The abandon Audit Events of one Check-In (CHECKINS.md §7). */
async function abandonAudits(checkInId: string) {
  const result = await app.pool?.query<{ actor_type: string; actor_id: string; payload: unknown }>(
    `SELECT actor_type, actor_id, payload FROM audit_events
      WHERE event_type = 'CHECKIN_ABANDONED' AND target_id = $1`,
    [checkInId],
  );
  return result?.rows ?? [];
}

async function veteranSession() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const user = await createVerifiedUser(pool, {
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

  it('returns the in-flight Check-In instead of starting a second one', async () => {
    const { headers } = await veteranSession();
    const first = await app.server.inject({ method: 'POST', url: '/api/v0/check-ins', headers });
    const second = await app.server.inject({ method: 'POST', url: '/api/v0/check-ins', headers });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const firstBody: { check_in_id: string; started_at: string } = first.json();
    const secondBody: { check_in_id: string; started_at: string } = second.json();
    expect(secondBody.check_in_id).toBe(firstBody.check_in_id);
    expect(Date.parse(firstBody.started_at)).not.toBeNaN();
    expect(secondBody.started_at).toBe(firstBody.started_at);
  });

  it('refuses an unauthenticated start', async () => {
    const response = await app.server.inject({ method: 'POST', url: '/api/v0/check-ins' });
    expect(response.statusCode).toBe(401);
  });

  // R12.8: the documented 422. Test files run one at a time, so the global version is
  // briefly unpublished here and restored whatever the outcome.
  it('answers 422 UNPROCESSABLE when no questionnaire version is published', async () => {
    const { headers } = await veteranSession();
    const pool = app.pool!;
    const unpublished = await pool.query<{ questionnaire_version: string }>(
      `UPDATE questionnaire_versions SET status = 'SUPERSEDED'
        WHERE tenant_id IS NULL AND status = 'PUBLISHED'
        RETURNING questionnaire_version`,
    );
    try {
      const response = await app.server.inject({
        method: 'POST',
        url: '/api/v0/check-ins',
        headers,
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe('UNPROCESSABLE');
    } finally {
      await pool.query(
        `UPDATE questionnaire_versions SET status = 'PUBLISHED' WHERE questionnaire_version = ANY($1)`,
        [unpublished.rows.map((row) => row.questionnaire_version)],
      );
    }
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

  it('refuses an option of another question, or an unknown id, with 400 and saves nothing', async () => {
    const { session, body } = await startOwned();
    const [first, second] = body.questions;
    if (first === undefined || second === undefined) throw new Error('need two questions');
    const foreignOption = second.options[0]?.answer_option_id;
    const attempts = [
      { question_id: first.question_id, answer_option_id: foreignOption },
      { question_id: first.question_id, answer_option_id: randomUUID() },
      { question_id: randomUUID(), answer_option_id: first.options[0]?.answer_option_id },
    ];
    for (const payload of attempts) {
      const response = await app.server.inject({
        method: 'POST',
        url: `/api/v0/check-ins/${body.check_in_id}/responses`,
        headers: session.headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
    const detail = await app.server.inject({
      method: 'GET',
      url: `/api/v0/check-ins/${body.check_in_id}`,
      headers: session.headers,
    });
    expect(detail.json()).toMatchObject({ status: 'STARTED', answered_question_ids: [] });
  });

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

  async function listUnfinished(headers: { authorization: string }, status = 'IN_PROGRESS') {
    return app.server.inject({
      method: 'GET',
      url: `/api/v0/check-ins?status=${status}`,
      headers,
    });
  }

  async function ageCheckIn(checkInId: string, hours: number) {
    await app.pool?.query(
      `UPDATE check_ins SET started_at = now() - make_interval(hours => $2) WHERE check_in_id = $1`,
      [checkInId, hours],
    );
  }

  it("lists the caller's fresh unfinished Check-In and no one else's", async () => {
    const { session, body } = await startOwned();
    const stranger = await veteranSession();

    const own = await listUnfinished(session.headers);
    expect(own.statusCode).toBe(200);
    const ownBody: { check_ins: { check_in_id: string; status: string }[] } = own.json();
    expect(ownBody.check_ins.map((entry) => entry.check_in_id)).toEqual([body.check_in_id]);
    expect(ownBody.check_ins[0]?.status).toBe('STARTED');

    const other = await listUnfinished(stranger.headers);
    expect(other.json()).toEqual({ check_ins: [] });
  });

  it('does not list a completed Check-In', async () => {
    const { session, body } = await startOwned();
    await answerAll(session.headers, body.check_in_id, body.questions, A0);
    await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
      headers: session.headers,
    });
    expect((await listUnfinished(session.headers)).json()).toEqual({ check_ins: [] });
  });

  async function checkInStatus(checkInId: string) {
    const result = await app.pool?.query<{ status: string; abandoned_at: Date | null }>(
      `SELECT status, abandoned_at FROM check_ins WHERE check_in_id = $1`,
      [checkInId],
    );
    return result?.rows[0];
  }

  it('refuses an answer to a Check-In past 24 hours and abandons it, without the sweep', async () => {
    const { session, body } = await startOwned();
    const [first] = body.questions;
    if (first === undefined) throw new Error('need a question');
    await ageCheckIn(body.check_in_id, 25);
    const saved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/responses`,
      headers: session.headers,
      payload: {
        question_id: first.question_id,
        answer_option_id: first.options[0]!.answer_option_id,
      },
    });
    expect(saved.statusCode).toBe(409);
    expect(saved.json().error.code).toBe('ILLEGAL_TRANSITION');
    const stored = await checkInStatus(body.check_in_id);
    expect(stored?.status).toBe('ABANDONED');
    expect(stored?.abandoned_at).not.toBeNull();
    expect(await abandonAudits(body.check_in_id)).toEqual([
      {
        actor_type: 'SYSTEM',
        actor_id: 'check-in-idle-timeout',
        payload: { questionnaire_version: expect.any(String), cause: 'IDLE_TIMEOUT' },
      },
    ]);
    const responses = await app.pool?.query(
      `SELECT 1 FROM check_in_responses WHERE check_in_id = $1`,
      [body.check_in_id],
    );
    expect(responses?.rowCount).toBe(0);
  });

  it('refuses to complete a Check-In that is too old, with no completion fact', async () => {
    const { session, body } = await startOwned();
    await answerAll(session.headers, body.check_in_id, body.questions, A0);
    await ageCheckIn(body.check_in_id, 25);
    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
      headers: session.headers,
    });
    expect(completed.statusCode).toBe(409);
    expect(completed.json().error.code).toBe('ILLEGAL_TRANSITION');
    expect((await checkInStatus(body.check_in_id))?.status).toBe('ABANDONED');
    const facts = await app.pool?.query(
      `SELECT 1 FROM domain_events WHERE event_type = 'CHECKIN_COMPLETED' AND aggregate_id = $1`,
      [body.check_in_id],
    );
    expect(facts?.rowCount).toBe(0);
  });

  it('still takes answers and completes just inside the 24-hour window', async () => {
    const { session, body } = await startOwned();
    await ageCheckIn(body.check_in_id, 23);
    await answerAll(session.headers, body.check_in_id, body.questions, A0);
    const completed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
      headers: session.headers,
    });
    expect(completed.statusCode).toBe(200);
    expect((await checkInStatus(body.check_in_id))?.status).toBe('COMPLETED');
  });

  it('does not list a Check-In started more than 24 hours ago', async () => {
    const { session, body } = await startOwned();
    await ageCheckIn(body.check_in_id, 25);
    expect((await listUnfinished(session.headers)).json()).toEqual({ check_ins: [] });
  });

  it('rejects a missing or other status filter with 400', async () => {
    const { session } = await startOwned();
    expect((await listUnfinished(session.headers, 'COMPLETED')).statusCode).toBe(400);
    const missing = await app.server.inject({
      method: 'GET',
      url: '/api/v0/check-ins',
      headers: session.headers,
    });
    expect(missing.statusCode).toBe(400);
  });

  it('refuses an unauthenticated list', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/check-ins?status=IN_PROGRESS',
    });
    expect(response.statusCode).toBe(401);
  });

  it('returns the answered question ids on the detail read', async () => {
    const { session, body } = await startOwned();
    const before = await app.server.inject({
      method: 'GET',
      url: `/api/v0/check-ins/${body.check_in_id}`,
      headers: session.headers,
    });
    expect(before.json().answered_question_ids).toEqual([]);

    const [first, second] = body.questions;
    if (first === undefined || second === undefined) throw new Error('need two questions');
    await answerAll(
      session.headers,
      body.check_in_id,
      [first, second],
      Object.fromEntries(
        [first, second].map((question) => [question.question_key, question.options[0]!.option_key]),
      ),
    );

    const after = await app.server.inject({
      method: 'GET',
      url: `/api/v0/check-ins/${body.check_in_id}`,
      headers: session.headers,
    });
    const detail: { answered_question_ids: string[]; status: string } = after.json();
    expect([...detail.answered_question_ids].sort()).toEqual(
      [first.question_id, second.question_id].sort(),
    );
    expect(detail.status).toBe('IN_PROGRESS');
  });
});

describe('abandonStaleCheckIns', () => {
  async function startAged(hours: number) {
    const session = await veteranSession();
    const started = await app.server.inject({
      method: 'POST',
      url: '/api/v0/check-ins',
      headers: session.headers,
    });
    const checkInId: string = started.json().check_in_id;
    await app.pool?.query(
      `UPDATE check_ins SET started_at = now() - make_interval(hours => $2) WHERE check_in_id = $1`,
      [checkInId, hours],
    );
    return checkInId;
  }

  async function statusOf(checkInId: string) {
    const result = await app.pool?.query<{ status: string; abandoned_at: Date | null }>(
      `SELECT status, abandoned_at FROM check_ins WHERE check_in_id = $1`,
      [checkInId],
    );
    return result?.rows[0];
  }

  it('abandons a stale Check-In, keeps a fresh one, and is replay-safe', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const stale = await startAged(25);
    const fresh = await startAged(1);

    await abandonStaleCheckIns(pool);
    const firstPass = await statusOf(stale);
    expect(firstPass?.status).toBe('ABANDONED');
    expect(firstPass?.abandoned_at).not.toBeNull();
    expect((await statusOf(fresh))?.status).toBe('STARTED');
    expect(await abandonAudits(stale)).toHaveLength(1);
    expect(await abandonAudits(fresh)).toEqual([]);

    const replay = await abandonStaleCheckIns(pool);
    expect(replay.abandoned).toBe(0);
    expect((await statusOf(stale))?.abandoned_at).toEqual(firstPass?.abandoned_at);
    // A replay finds nothing to abandon, so it writes no second Audit Event.
    expect(await abandonAudits(stale)).toHaveLength(1);
  });
});
