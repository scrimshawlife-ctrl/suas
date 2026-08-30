/**
 * Unassigned queue and claim (requires PostgreSQL).
 *
 * SUAS-specs RESPONDER_WORKFLOWS.md §2 / §4; API.md §8.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { openCase } from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { createMembership, createOrganization, createUser } from '../../src/identity/index.js';
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

async function bearer(tenantId: string, userId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId });
  return { authorization: `Bearer ${session.credential}` };
}

async function completeRedCheckIn() {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const tenantId = randomUUID();
  const veteran = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  await ensurePublishedQv001(pool, veteran.userId);
  const veteranHeaders = await bearer(tenantId, veteran.userId);
  const started = await app.server.inject({
    method: 'POST',
    url: '/api/v0/check-ins',
    headers: veteranHeaders,
  });
  expect(started.statusCode).toBe(201);
  const body: { check_in_id: string; questions: QuestionJson[] } = started.json();
  for (const question of body.questions) {
    const optionKey =
      question.question_key === 'safe_now' ? 'NO_IMMEDIATE_HELP' : A0[question.question_key];
    if (optionKey === undefined) continue;
    const option = question.options.find((entry) => entry.option_key === optionKey);
    if (option === undefined) throw new Error(`missing ${optionKey}`);
    const saved = await app.server.inject({
      method: 'POST',
      url: `/api/v0/check-ins/${body.check_in_id}/responses`,
      headers: veteranHeaders,
      payload: { question_id: question.question_id, answer_option_id: option.answer_option_id },
    });
    expect(saved.statusCode).toBe(200);
  }
  const completed = await app.server.inject({
    method: 'POST',
    url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
    headers: veteranHeaders,
  });
  expect(completed.statusCode).toBe(200);
  const result: { support_case: { case_id: string } | null } = completed.json();
  expect(result.support_case?.case_id).toBeDefined();
  return { tenantId, veteran, caseId: result.support_case?.case_id ?? '', veteranHeaders };
}

async function responderOn(tenantId: string) {
  const pool = app.pool;
  if (pool === undefined) throw new Error('no pool');
  const user = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`resp-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  const org = await createOrganization(pool, {
    tenantId,
    name: 'Example QRF',
    status: 'ACTIVE',
  });
  await createMembership(pool, {
    tenantId,
    userId: user.userId,
    organizationId: org.organizationId,
    role: 'RESPONDER',
    status: 'ACTIVE',
  });
  return { user, headers: await bearer(tenantId, user.userId) };
}

describe('POST /api/v0/cases', () => {
  it('opens one Veteran case and replays the authoritative result', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-open-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const headers = {
      ...(await bearer(tenantId, veteran.userId)),
      'idempotency-key': randomUUID(),
    };

    const opened = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers,
    });
    expect(opened.statusCode).toBe(201);
    expect(opened.json()).toMatchObject({ status: 'OPEN', created: true, replayed: false });

    const replayed = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers,
    });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual({ ...opened.json(), replayed: true });

    const reused = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: { ...headers, 'idempotency-key': randomUUID() },
    });
    expect(reused.statusCode).toBe(200);
    expect(reused.json()).toMatchObject({
      case_id: opened.json().case_id,
      status: 'OPEN',
      created: false,
      replayed: false,
    });
  });

  it('requires authentication and an idempotency key', async () => {
    const unauthenticated = await app.server.inject({ method: 'POST', url: '/api/v0/cases' });
    expect(unauthenticated.statusCode).toBe(401);

    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-key-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const missingKey = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: await bearer(tenantId, veteran.userId),
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json().error.code).toBe('VALIDATION_FAILED');
  });
});

describe('GET /api/v0/cases', () => {
  it('hides the unassigned queue from a veteran', async () => {
    const { tenantId, veteranHeaders } = await completeRedCheckIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned',
      headers: veteranHeaders,
    });
    expect(response.statusCode).toBe(403);
    expect(tenantId).toBeDefined();
  });

  it('lists a RED Check-In case as unassigned and lets a responder claim it', async () => {
    const { tenantId, caseId } = await completeRedCheckIn();
    const responder = await responderOn(tenantId);
    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned',
      headers: responder.headers,
    });
    expect(listed.statusCode).toBe(200);
    const page: { cases: { case_id: string; priority_signal_level: string | null }[] } =
      listed.json();
    expect(page.cases.some((entry) => entry.case_id === caseId)).toBe(true);
    expect(page.cases.find((entry) => entry.case_id === caseId)?.priority_signal_level).toBe('RED');

    const claimed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${caseId}/commands/claim`,
      headers: responder.headers,
    });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json().status).toBe('ASSIGNED');

    const mine = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=mine',
      headers: responder.headers,
    });
    const minePage: { cases: { case_id: string }[] } = mine.json();
    expect(minePage.cases.some((entry) => entry.case_id === caseId)).toBe(true);

    const dashboard = await app.server.inject({
      method: 'GET',
      url: '/app/responder',
      headers: responder.headers,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('Unassigned');
    expect(dashboard.body).toContain(caseId);
  });
});

/**
 * Cursor pagination over the responder queue.
 *
 * SUAS-specs API.md §5: growing lists are cursor-paginated with `cursor` +
 * `limit`, default 20 and maximum 100, and no unbounded sensitive list endpoint.
 * TESTING.md §8 requires bounded page size and deterministic keyset-safe ordering.
 */
describe('GET /api/v0/cases pagination', () => {
  /** Distinct veterans, because CASES.md §3.1 allows one active case each. */
  async function openCasesFor(tenantId: string, count: number): Promise<string[]> {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const caseIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const veteran = await createUser(pool, {
        tenantId,
        email: syntheticEmail(`vet-page-${randomUUID().slice(0, 8)}`),
        status: 'ACTIVE',
      });
      const opened = await withTransaction(pool, (tx) =>
        openCase(tx, {
          tenantId,
          veteranUserId: veteran.userId,
          actorType: 'SYSTEM',
          actorId: veteran.userId,
        }),
      );
      caseIds.push(opened.supportCase.caseId);
    }
    return caseIds;
  }

  it('walks every case exactly once across pages', async () => {
    const tenantId = randomUUID();
    const opened = await openCasesFor(tenantId, 5);
    const responder = await responderOn(tenantId);

    const seen: string[] = [];
    let url = '/api/v0/cases?ownership=unassigned&limit=2';
    let pages = 0;

    for (;;) {
      const response = await app.server.inject({ method: 'GET', url, headers: responder.headers });
      expect(response.statusCode).toBe(200);
      const page: { cases: { case_id: string }[]; next_cursor: string | null } = response.json();
      expect(page.cases.length).toBeLessThanOrEqual(2);
      seen.push(...page.cases.map((entry) => entry.case_id));
      pages += 1;
      if (page.next_cursor === null) break;
      if (pages > 10) throw new Error('cursor did not terminate');
      url = `/api/v0/cases?ownership=unassigned&limit=2&cursor=${encodeURIComponent(page.next_cursor)}`;
    }

    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...opened].sort());
  });

  it('defaults to a bounded page and caps an oversized limit', async () => {
    const tenantId = randomUUID();
    await openCasesFor(tenantId, 1);
    const responder = await responderOn(tenantId);

    const defaulted = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned',
      headers: responder.headers,
    });
    expect(defaulted.statusCode).toBe(200);

    // Above MAX_PAGE_SIZE the request is rejected rather than silently widened,
    // so a client cannot ask for an unbounded page (API.md §5).
    const oversized = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned&limit=101',
      headers: responder.headers,
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().error.code).toBe('VALIDATION_FAILED');

    const zero = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned&limit=0',
      headers: responder.headers,
    });
    expect(zero.statusCode).toBe(400);
  });

  it('rejects a malformed cursor with 400 rather than failing internally', async () => {
    const tenantId = randomUUID();
    await openCasesFor(tenantId, 1);
    const responder = await responderOn(tenantId);

    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned&cursor=not-a-real-cursor',
      headers: responder.headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('keeps a cursor scoped to its tenant', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await openCasesFor(tenantA, 3);
    const openedB = await openCasesFor(tenantB, 3);

    const responderA = await responderOn(tenantA);
    const firstA = await app.server.inject({
      method: 'GET',
      url: '/api/v0/cases?ownership=unassigned&limit=1',
      headers: responderA.headers,
    });
    const pageA: { next_cursor: string | null } = firstA.json();
    expect(pageA.next_cursor).not.toBeNull();

    // Replaying tenant A's cursor as tenant B must not leak tenant A rows; the
    // tenant comes from the session, never from the cursor (API.md §4).
    const responderB = await responderOn(tenantB);
    const replay = await app.server.inject({
      method: 'GET',
      url: `/api/v0/cases?ownership=unassigned&cursor=${encodeURIComponent(pageA.next_cursor ?? '')}`,
      headers: responderB.headers,
    });
    expect(replay.statusCode).toBe(200);
    const pageB: { cases: { case_id: string }[] } = replay.json();
    for (const entry of pageB.cases) {
      expect(openedB).toContain(entry.case_id);
    }
  });
});
