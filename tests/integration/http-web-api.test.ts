/**
 * API additions for the v1 web app (requires PostgreSQL): self sign-up by email code,
 * display name, meeting place, the new read shapes, chat threads, and the
 * accepter/requester command split.
 *
 * V1_PROJECT_PLAN.md §2.1 "Peer flow"; SUAS-specs API.md §4 (no existence leakage).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession, type RecordingChallengeDelivery } from '../../src/auth/index.js';
import {
  DisclosureGuardRequiredError,
  executeServiceRequestCommand,
} from '../../src/coordination/index.js';
import { createUser, grantSuasAdmin, setUserStatus } from '../../src/identity/index.js';
import type { ModelToolCall, ScriptedModelInference } from '../../src/inference/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

/** The tenant that new email addresses sign up into (deployment config, not the request). */
const SIGN_UP_TENANT = randomUUID();

let app: StartedApp;
let model: ScriptedModelInference;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_BROWSER_TENANT_ID: SIGN_UP_TENANT,
      SUAS_MODEL_INFERENCE_MODE: 'fake',
    }),
    listen: false,
  });
  model = app.modelInference as ScriptedModelInference;
});

afterAll(async () => {
  await app.close();
});

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

function delivery(): RecordingChallengeDelivery {
  return app.challengeDelivery as RecordingChallengeDelivery;
}

interface Person {
  readonly tenantId: string;
  readonly userId: string;
  readonly headers: Record<string, string>;
}

async function person(
  tenantId: string,
  options: { county?: 'SANTA_CLARA' | 'ALAMEDA'; verified?: boolean; admin?: boolean } = {},
): Promise<Person> {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`web-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    ...(options.county !== undefined ? { county: options.county } : {}),
  });
  if (options.verified === true) await markVerifiedVeteran(pool(), tenantId, user.userId);
  if (options.admin === true) await grantSuasAdmin(pool(), user.userId, undefined);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return {
    tenantId,
    userId: user.userId,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

function keyed(who: Person): Record<string, string> {
  return { ...who.headers, 'idempotency-key': randomUUID() };
}

function getJson(url: string, who?: Person) {
  return app.server.inject({ method: 'GET', url, ...(who ? { headers: who.headers } : {}) });
}

async function postJson(url: string, who: Person, payload: Record<string, unknown>) {
  return app.server.inject({ method: 'POST', url, headers: keyed(who), payload });
}

/** A verified requester submits a request through the plain form. */
async function submitForm(
  requester: Person,
  body: Record<string, unknown> = {},
): Promise<{ id: string; caseId: string }> {
  const response = await postJson('/api/v0/service-requests', requester, {
    category: 'FOOD',
    summary: 'Groceries for the week',
    timing: 'Friday afternoon',
    meeting_place: 'Front steps of the library',
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return { id: response.json().service_request_id, caseId: response.json().case_id };
}

function accept(who: Person, id: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${id}/accept`,
    headers: who.headers,
  });
}

describe('self sign-up by email code', () => {
  async function issue(email: string) {
    return app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { destination: email, method: 'EMAIL_OTP' },
    });
  }

  function verify(email: string, code: string) {
    return app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges/commands/verify',
      payload: { destination: email, code },
    });
  }

  it('sends a code to an unknown email, and verifying it creates an ACTIVE user with a session', async () => {
    const email = syntheticEmail(`new-${randomUUID().slice(0, 8)}`);
    const issued = await issue(email);
    expect(issued.statusCode).toBe(202);
    expect(issued.json()).toEqual({ status: 'accepted' });

    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    expect(code).not.toBe('');
    const verified = await verify(email, code);
    expect(verified.statusCode).toBe(201);

    const me = await app.server.inject({
      method: 'GET',
      url: '/api/v0/veterans/me',
      headers: { authorization: `Bearer ${verified.json().session_credential}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      status: 'ACTIVE',
      county: null,
      display_name: null,
      is_admin: false,
      enrolled_channels: { email: true, phone: false },
    });
    const row = await pool().query(`SELECT tenant_id FROM users WHERE lower(email) = $1`, [
      email.toLowerCase(),
    ]);
    expect(row.rows).toEqual([{ tenant_id: SIGN_UP_TENANT }]);
  });

  it('answers an unknown and a known email with the same 202', async () => {
    const known = await person(SIGN_UP_TENANT);
    const knownEmail = (
      await pool().query<{ email: string }>(`SELECT email FROM users WHERE user_id = $1`, [
        known.userId,
      ])
    ).rows[0]?.email;
    const a = await issue(knownEmail ?? '');
    const b = await issue(syntheticEmail(`stranger-${randomUUID().slice(0, 8)}`));
    expect(b.statusCode).toBe(a.statusCode);
    expect(b.body).toBe(a.body);
  });

  it('does not sign up a value that is not an email address', async () => {
    const junk = `not-an-email-${randomUUID().slice(0, 8)}`;
    const issued = await issue(junk);
    expect(issued.statusCode).toBe(202);
    expect(delivery().lastFor(junk)).toBeUndefined();
  });

  it('sends nothing to, and gives no session to, a suspended user', async () => {
    const suspended = await person(SIGN_UP_TENANT);
    const email = (
      await pool().query<{ email: string }>(`SELECT email FROM users WHERE user_id = $1`, [
        suspended.userId,
      ])
    ).rows[0]?.email as string;

    // A code issued while the user was active stops working once they are suspended.
    expect((await issue(email)).statusCode).toBe(202);
    const code = delivery().lastFor(email.toLowerCase())?.secret ?? '';
    await setUserStatus(pool(), SIGN_UP_TENANT, suspended.userId, 'SUSPENDED');
    const refused = await verify(email, code);
    expect(refused.statusCode).toBe(401);
    expect(refused.json().error.code).toBe('CHALLENGE_INVALID');

    // And a suspended address is not treated as a new one: no code goes out.
    const before = delivery().lastFor(email.toLowerCase())?.secret;
    expect((await issue(email)).statusCode).toBe(202);
    expect(delivery().lastFor(email.toLowerCase())?.secret).toBe(before);
  });
});

describe('display name and the me projection', () => {
  it('sets a trimmed display name without the ID scan, and rejects empty or long names', async () => {
    const who = await person(randomUUID());
    const set = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/profile',
      headers: who.headers,
      payload: { display_name: '  Marcus T.  ' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toEqual({ display_name: 'Marcus T.' });

    const me = await getJson('/api/v0/veterans/me', who);
    expect(me.json()).toMatchObject({ display_name: 'Marcus T.', is_admin: false });

    for (const display_name of ['', '   ', 'x'.repeat(41)]) {
      const bad = await app.server.inject({
        method: 'PUT',
        url: '/api/v0/veterans/me/profile',
        headers: who.headers,
        payload: { display_name },
      });
      expect(bad.statusCode).toBe(400);
    }
    const anonymous = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/profile',
      payload: { display_name: 'Marcus T.' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('reports is_admin from the SUAS admin grant', async () => {
    const admin = await person(randomUUID(), { admin: true });
    expect((await getJson('/api/v0/veterans/me', admin)).json().is_admin).toBe(true);
  });

  it('refuses a name the database check would reject, even if the API were bypassed', async () => {
    const who = await person(randomUUID());
    await expect(
      pool().query(`UPDATE users SET display_name = ' padded ' WHERE user_id = $1`, [who.userId]),
    ).rejects.toThrow(/users_display_name_check/);
  });
});

describe('meeting place', () => {
  const MARKER = `zz-meet-${randomUUID()}`;

  it('is required to submit FOOD, TRANSPORTATION and SHELTER, and optional for PEER_SUPPORT', async () => {
    const requester = await person(randomUUID(), { verified: true });
    for (const category of ['FOOD', 'TRANSPORTATION', 'SHELTER']) {
      const refused = await postJson('/api/v0/service-requests', requester, {
        category,
        summary: 'Need help',
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json().error.code).toBe('UNPROCESSABLE');
      expect(refused.json().error.message).toContain('meeting_place');
    }
    const peer = await postJson('/api/v0/service-requests', requester, {
      category: 'PEER_SUPPORT',
      summary: 'Someone to talk to',
    });
    expect(peer.statusCode).toBe(201);
    const tooLong = await postJson('/api/v0/service-requests', requester, {
      category: 'FOOD',
      summary: 'Need help',
      meeting_place: 'x'.repeat(201),
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('is enforced when a draft is submitted, and the model can fill it', async () => {
    const requester = await person(randomUUID(), { verified: true, county: 'SANTA_CLARA' });
    const draftCall = (input: Record<string, unknown>): ModelToolCall => ({
      id: 'd1',
      name: 'draft_service_request',
      input,
    });
    model.enqueue(
      { ok: true, text: '', toolCalls: [draftCall({ category: 'SHELTER', summary: 'A bed' })] },
      { ok: true, text: 'Drafted.', toolCalls: [] },
    );
    const created = await postJson('/api/v0/intake/drafts', requester, { text: 'I need a bed.' });
    expect(created.statusCode).toBe(201);
    const draftId: string = created.json().draft.draft_id;
    expect(created.json().draft.meeting_place).toBeNull();

    const refused = await postJson(`/api/v0/intake/drafts/${draftId}/submit`, requester, {});
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error.message).toContain('meeting_place');

    const edited = await app.server.inject({
      method: 'PATCH',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers: requester.headers,
      payload: { meeting_place: 'Shelter front desk' },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json().meeting_place).toBe('Shelter front desk');
    const submitted = await postJson(`/api/v0/intake/drafts/${draftId}/submit`, requester, {});
    expect(submitted.statusCode).toBe(201);

    model.enqueue(
      {
        ok: true,
        text: '',
        toolCalls: [
          draftCall({
            category: 'FOOD',
            summary: 'Groceries',
            meeting_place: 'Community center lobby',
          }),
        ],
      },
      { ok: true, text: 'Drafted.', toolCalls: [] },
    );
    const second = await postJson('/api/v0/intake/drafts', requester, { text: 'Food please.' });
    expect(second.json().draft.meeting_place).toBe('Community center lobby');
  });

  it('is never in the open list, events or audit records, and only the two people see it', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const stranger = await person(tenantId, { county: 'SANTA_CLARA' });
    const { id } = await submitForm(requester, { meeting_place: `Library ${MARKER}` });

    const open = await getJson('/api/v0/service-requests?ownership=open', helper);
    expect(open.statusCode).toBe(200);
    const listed = open.json().service_requests[0];
    expect(listed).toMatchObject({ service_request_id: id, summary: 'Groceries for the week' });
    expect(listed).not.toHaveProperty('meeting_place');
    expect(listed).not.toHaveProperty('timing');
    expect(open.body).not.toContain(MARKER);

    expect((await accept(helper, id)).statusCode).toBe(200);
    const events = await pool().query(
      `SELECT (SELECT count(*) FROM domain_events WHERE payload::text LIKE $1)
            + (SELECT count(*) FROM audit_events WHERE payload::text LIKE $1) AS n`,
      [`%${MARKER}%`],
    );
    expect(Number(events.rows[0].n)).toBe(0);

    for (const who of [requester, helper]) {
      const detail = await getJson(`/api/v0/service-requests/${id}`, who);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        service_request_id: id,
        summary: 'Groceries for the week',
        timing: 'Friday afternoon',
        meeting_place: `Library ${MARKER}`,
        widened: false,
        county: 'SANTA_CLARA',
      });
      expect(typeof detail.json().created_at).toBe('string');
    }
    expect((await getJson(`/api/v0/service-requests/${id}`, stranger)).statusCode).toBe(404);
  });
});

describe('counterpart names', () => {
  async function setName(who: Person, display_name: string) {
    const response = await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/profile',
      headers: who.headers,
      payload: { display_name },
    });
    expect(response.statusCode).toBe(200);
  }

  it('shows each of the two people the other one name, and nobody else anything', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const stranger = await person(tenantId, { county: 'SANTA_CLARA' });
    await setName(requester, 'Dana R.');
    await setName(helper, 'Marcus T.');
    const { id } = await submitForm(requester);

    // R5.11: the open list is category, county, status and the one-line summary.
    // The requester's display name, timing and meeting place wait until accept.
    const open = await getJson('/api/v0/service-requests?ownership=open', helper);
    expect(open.statusCode).toBe(200);
    const listed = open.json().service_requests[0];
    expect(listed).toMatchObject({
      service_request_id: id,
      summary: 'Groceries for the week',
      county: 'SANTA_CLARA',
    });
    expect(listed).not.toHaveProperty('counterpart_display_name');
    expect(listed).not.toHaveProperty('timing');
    expect(listed).not.toHaveProperty('meeting_place');
    expect(open.body).not.toContain('Dana R.');
    expect(open.body).not.toContain('Friday afternoon');
    expect(open.body).not.toContain('Front steps of the library');

    // Before anyone accepts, the owner has no counterpart.
    const before = await getJson(`/api/v0/service-requests/${id}`, requester);
    expect(before.json().counterpart_display_name).toBeNull();

    expect((await accept(helper, id)).statusCode).toBe(200);
    const asOwner = await getJson(`/api/v0/service-requests/${id}`, requester);
    expect(asOwner.json().counterpart_display_name).toBe('Marcus T.');
    expect(asOwner.json().viewer_role).toBe('REQUESTER');
    const asAccepter = await getJson(`/api/v0/service-requests/${id}`, helper);
    expect(asAccepter.json().counterpart_display_name).toBe('Dana R.');
    expect(asAccepter.json().viewer_role).toBe('ACCEPTER');
    expect((await getJson(`/api/v0/service-requests/${id}`, stranger)).statusCode).toBe(404);

    const mine = await getJson('/api/v0/service-requests?ownership=mine', helper);
    expect(mine.json().service_requests[0]).toMatchObject({
      service_request_id: id,
      summary: 'Groceries for the week',
      counterpart_display_name: 'Dana R.',
    });
  });
});

describe('ownership=requested', () => {
  it('lists only the caller own requests in any status, newest first, with paging', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const other = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const first = await submitForm(requester, { summary: 'First' });
    const cancelled = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${first.id}/commands/CANCEL`,
      headers: keyed(requester),
      payload: { reason: 'sorted it out' },
    });
    expect(cancelled.statusCode).toBe(200);
    const second = await submitForm(requester, { summary: 'Second' });
    await submitForm(other, { summary: 'Not yours' });

    const all = await getJson('/api/v0/service-requests?ownership=requested', requester);
    expect(all.statusCode).toBe(200);
    const items: {
      summary: string;
      created_at: string;
      updated_at: string;
      closed_at: string | null;
    }[] = all.json().service_requests;
    expect(items.map((item) => item.summary)).toEqual(['Second', 'First']);
    expect(items[0]).toMatchObject({
      service_request_id: second.id,
      case_id: second.caseId,
      category: 'FOOD',
      status: 'SUBMITTED',
      closed_at: null,
    });
    expect(items[1]).toMatchObject({ status: 'CANCELLED' });
    expect(typeof items[1]?.closed_at).toBe('string');
    expect(typeof items[0]?.created_at).toBe('string');
    expect(typeof items[0]?.updated_at).toBe('string');

    const page = await getJson('/api/v0/service-requests?ownership=requested&limit=1', requester);
    expect(page.json().service_requests).toHaveLength(1);
    const cursor: string = page.json().next_cursor;
    expect(cursor).toBeTruthy();
    const next = await getJson(
      `/api/v0/service-requests?ownership=requested&limit=1&cursor=${encodeURIComponent(cursor)}`,
      requester,
    );
    expect(next.json().service_requests[0].summary).toBe('First');
  });

  it('needs only a signed-in person: no county and no ID scan', async () => {
    const newcomer = await person(randomUUID());
    const response = await getJson('/api/v0/service-requests?ownership=requested', newcomer);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service_requests: [], next_cursor: null });
    expect((await getJson('/api/v0/service-requests?ownership=requested')).statusCode).toBe(401);
  });
});

describe('GET /api/v0/chat/threads', () => {
  async function send(who: Person, id: string, body: string) {
    const response = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/chat/messages`,
      headers: keyed(who),
      payload: { body },
    });
    expect(response.statusCode).toBe(201);
  }

  it('lists a thread for its two participants only, newest activity first', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const otherRequester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const stranger = await person(tenantId, { county: 'SANTA_CLARA' });
    await app.server.inject({
      method: 'PUT',
      url: '/api/v0/veterans/me/profile',
      headers: helper.headers,
      payload: { display_name: 'Marcus T.' },
    });
    const older = await submitForm(requester, { summary: 'Older' });
    const newer = await submitForm(otherRequester, {
      summary: 'Newer',
      category: 'PEER_SUPPORT',
    });
    expect((await accept(helper, older.id)).statusCode).toBe(200);
    expect((await accept(helper, newer.id)).statusCode).toBe(200);
    await send(requester, older.id, 'y'.repeat(300));
    await send(helper, newer.id, 'On my way');
    await send(helper, older.id, 'z'.repeat(300));

    const asRequester = await getJson('/api/v0/chat/threads', requester);
    expect(asRequester.statusCode).toBe(200);
    expect(asRequester.json().threads).toHaveLength(1);
    expect(asRequester.json().threads[0]).toMatchObject({
      service_request_id: older.id,
      category: 'FOOD',
      summary: 'Older',
      counterpart_display_name: 'Marcus T.',
      last_message_body: 'z'.repeat(140),
      closed: false,
      role: 'REQUESTER',
      last_message_from_me: false,
    });
    expect(typeof asRequester.json().threads[0].last_message_at).toBe('string');

    const asHelper = await getJson('/api/v0/chat/threads', helper);
    const threads: {
      service_request_id: string;
      last_message_body: string | null;
      counterpart_display_name: string | null;
      role: string;
      last_message_from_me: boolean | null;
    }[] = asHelper.json().threads;
    // Newest activity first: the reply on the older request came last.
    expect(threads.map((t) => t.service_request_id)).toEqual([older.id, newer.id]);
    expect(threads[1]?.last_message_body).toBe('On my way');
    expect(threads.map((t) => [t.role, t.last_message_from_me])).toEqual([
      ['ACCEPTER', true],
      ['ACCEPTER', true],
    ]);
    expect(threads[0]?.counterpart_display_name).toBeNull();
    expect((await getJson('/api/v0/chat/threads', stranger)).json().threads).toEqual([]);
    expect((await getJson('/api/v0/chat/threads')).statusCode).toBe(401);
  });

  it('marks a thread closed once its request is in a terminal status', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const { id } = await submitForm(requester);
    expect((await accept(helper, id)).statusCode).toBe(200);
    const open = await getJson('/api/v0/chat/threads', requester);
    expect(open.json().threads[0]).toMatchObject({
      closed: false,
      last_message_body: null,
      role: 'REQUESTER',
      last_message_from_me: null,
    });
    expect(open.json().threads[0].last_message_at).toBeNull();

    const cancelled = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/commands/CANCEL`,
      headers: keyed(requester),
      payload: { reason: 'no longer needed' },
    });
    expect(cancelled.statusCode).toBe(200);
    const closed = await getJson('/api/v0/chat/threads', helper);
    expect(closed.json().threads[0].closed).toBe(true);
  });
});

describe('requester-only commands', () => {
  it('lets only the requester CONFIRM, CANCEL or SUBMIT; the accepter gets 403', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const { id } = await submitForm(requester);
    expect((await accept(helper, id)).statusCode).toBe(200);

    for (const command of ['CONFIRM', 'CANCEL', 'SUBMIT']) {
      const refused = await app.server.inject({
        method: 'POST',
        url: `/api/v0/service-requests/${id}/commands/${command}`,
        headers: keyed(helper),
        payload: { reason: 'not mine to run' },
      });
      expect(refused.statusCode).toBe(403);
    }
    const detail = await getJson(`/api/v0/service-requests/${id}`, requester);
    expect(detail.json().status).toBe('ACCEPTED');

    const cancelled = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/commands/CANCEL`,
      headers: keyed(requester),
      payload: { reason: 'changed my mind' },
    });
    expect(cancelled.statusCode).toBe(200);
  });
});

describe('sign-in answers do not depend on who is enrolled', () => {
  async function emailOf(userId: string): Promise<string> {
    const row = await pool().query<{ email: string }>(
      `SELECT email FROM users WHERE user_id = $1`,
      [userId],
    );
    return row.rows[0]?.email ?? '';
  }

  const issue = (destination: string) =>
    app.server.inject({
      method: 'POST',
      url: '/api/v0/auth/challenges',
      payload: { destination, method: 'EMAIL_OTP' },
    });

  it('writes a challenge row and an audit event even when no code is sent', async () => {
    const suspended = await person(SIGN_UP_TENANT);
    await setUserStatus(pool(), SIGN_UP_TENANT, suspended.userId, 'SUSPENDED');
    const email = await emailOf(suspended.userId);
    expect((await issue(email)).statusCode).toBe(202);

    const rows = await pool().query<{ status: string }>(
      `SELECT status FROM auth_challenges WHERE user_id = $1`,
      [suspended.userId],
    );
    expect(rows.rows).toEqual([{ status: 'REVOKED' }]);
    const audit = await pool().query(
      `SELECT 1 FROM audit_events WHERE aggregate_id = $1 AND event_type = 'AUTH_CHALLENGE_ISSUE_SKIPPED'`,
      [suspended.userId],
    );
    expect(audit.rowCount).toBe(1);
    expect(delivery().lastFor(email.toLowerCase())).toBeUndefined();
  });

  it('still answers 202, and audits the failure, when the send fails', async () => {
    const enrolled = await person(SIGN_UP_TENANT);
    const enrolledEmail = await emailOf(enrolled.userId);
    const newEmail = syntheticEmail(`fail-${randomUUID().slice(0, 8)}`);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const send = vi.spyOn(delivery(), 'deliver').mockRejectedValue(new Error('provider down'));
    try {
      const known = await issue(enrolledEmail);
      const unknown = await issue(newEmail);
      expect(known.statusCode).toBe(202);
      expect(unknown.statusCode).toBe(202);
      expect(unknown.body).toBe(known.body);
    } finally {
      send.mockRestore();
      quiet.mockRestore();
    }
    const failures = await pool().query(
      `SELECT 1 FROM audit_events WHERE aggregate_id = $1 AND event_type = 'AUTH_CHALLENGE_DELIVERY_FAILED'`,
      [enrolled.userId],
    );
    expect(failures.rowCount).toBe(1);
  });

  it('survives a sign-up that loses the unique-index race, without echoing the address', async () => {
    // A trigger stands in for a concurrent insert of the same address: it raises the
    // unique violation, with the address in the error detail as Postgres does.
    const email = syntheticEmail(`race-${randomUUID().slice(0, 8)}`).toLowerCase();
    const suffix = randomUUID().slice(0, 8).replaceAll('-', '');
    const fn = `race_fn_${suffix}`;
    await pool().query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'duplicate' USING ERRCODE = '23505', DETAIL = NEW.email; END $$`,
    );
    await pool().query(
      `CREATE TRIGGER race_trg_${suffix} BEFORE INSERT ON users FOR EACH ROW
         WHEN (NEW.email = '${email}') EXECUTE FUNCTION ${fn}()`,
    );
    try {
      expect((await issue(email)).statusCode).toBe(202);
      const code = delivery().lastFor(email)?.secret ?? '';
      const refused = await app.server.inject({
        method: 'POST',
        url: '/api/v0/auth/challenges/commands/verify',
        payload: { destination: email, code },
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json().error.code).toBe('CHALLENGE_INVALID');
      expect(refused.body).not.toContain(email);
    } finally {
      await pool().query(`DROP TRIGGER race_trg_${suffix} ON users`);
      await pool().query(`DROP FUNCTION ${fn}()`);
    }
  });
});

describe('request summaries and case-route details are bounded', () => {
  it('lists a summary only when it is a string, cut to 280 characters', async () => {
    const tenantId = randomUUID();
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const other = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const long = await submitForm(requester, {
      category: 'PEER_SUPPORT',
      meeting_place: undefined,
    });
    const odd = await submitForm(other, { category: 'PEER_SUPPORT', meeting_place: undefined });
    await pool().query(
      `UPDATE service_requests SET details = jsonb_build_object('summary', repeat('x', 500))
        WHERE service_request_id = $1`,
      [long.id],
    );
    await pool().query(
      `UPDATE service_requests SET details = jsonb_build_object('summary', 12345)
        WHERE service_request_id = $1`,
      [odd.id],
    );
    const items: { service_request_id: string; summary: string | null }[] = (
      await getJson('/api/v0/service-requests?ownership=open', helper)
    ).json().service_requests;
    const byId = new Map(items.map((item) => [item.service_request_id, item.summary]));
    expect(byId.get(long.id)).toBe('x'.repeat(280));
    expect(byId.get(odd.id)).toBeNull();
  });

  it('refuses unknown or over-long details on POST /cases/{caseId}/service-requests', async () => {
    const requester = await person(randomUUID(), { verified: true, county: 'SANTA_CLARA' });
    const opened = await postJson('/api/v0/cases', requester, {});
    const caseId: string = opened.json().case_id;
    for (const details of [{ purpose: 'x' }, { summary: 'x'.repeat(281) }, { meeting_place: '' }]) {
      const refused = await postJson(`/api/v0/cases/${caseId}/service-requests`, requester, {
        category: 'PEER_SUPPORT',
        details,
      });
      expect(refused.statusCode).toBe(400);
    }
    const ok = await postJson(`/api/v0/cases/${caseId}/service-requests`, requester, {
      category: 'FOOD',
      details: { summary: 'Groceries', timing: 'Friday', meeting_place: 'Library' },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe('peer accept moves the request to ACCEPTED', () => {
  function command(who: Person, id: string, name: string, payload: Record<string, unknown> = {}) {
    return app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/commands/${name}`,
      headers: keyed(who),
      payload,
    });
  }

  it('accepts the request with the case, then runs START, FULFILL and the owner CONFIRM', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const waiting = await person(tenantId, { county: 'SANTA_CLARA' });
    const { id, caseId } = await submitForm(requester, {
      category: 'PEER_SUPPORT',
      meeting_place: undefined,
    });
    const before = await getJson('/api/v0/veterans/me', requester);
    expect(before.json().active_qrf.state).toBe('REQUESTED');

    expect((await accept(helper, id)).statusCode).toBe(200);

    for (const who of [requester, helper]) {
      expect((await getJson(`/api/v0/service-requests/${id}`, who)).json().status).toBe('ACCEPTED');
    }
    expect((await getJson(`/api/v0/cases/${caseId}`, helper)).json().status).toBe('ASSIGNED');
    const me = await getJson('/api/v0/veterans/me', requester);
    expect(me.json().active_qrf).toMatchObject({
      service_request_id: id,
      state: 'RESPONDER_ACCEPTED',
    });

    // It leaves the open list, and one audit event records the peer accept (ids only).
    expect(
      (await getJson('/api/v0/service-requests?ownership=open', waiting)).json(),
    ).toMatchObject({
      service_requests: [],
    });
    const audit = await pool().query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events
        WHERE target_id = $1 AND event_type = 'SERVICE_REQUEST_PEER_ACCEPTED'`,
      [id],
    );
    expect(audit.rows).toEqual([
      { payload: { case_id: caseId, category: 'PEER_SUPPORT', from_status: 'SUBMITTED' } },
    ]);

    const started = await command(helper, id, 'START');
    expect(started.statusCode).toBe(200);
    expect(started.json().status).toBe('IN_PROGRESS');
    const fulfilled = await command(helper, id, 'FULFILL');
    expect(fulfilled.json().status).toBe('FULFILLED');
    const confirmed = await command(requester, id, 'CONFIRM');
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().status).toBe('CONFIRMED');
  });

  it('leaves exactly one ACCEPTED transition when two people race', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const a = await person(tenantId, { county: 'SANTA_CLARA' });
    const b = await person(tenantId, { county: 'SANTA_CLARA' });
    const { id } = await submitForm(requester);
    const results = await Promise.all([accept(a, id), accept(b, id)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const audit = await pool().query(
      `SELECT 1 FROM audit_events WHERE target_id = $1 AND event_type = 'SERVICE_REQUEST_PEER_ACCEPTED'`,
      [id],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('refuses a request that is no longer waiting, and keeps the consent guard on ASSIGN', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const { id } = await submitForm(requester);
    const cancelled = await command(requester, id, 'CANCEL', { reason: 'sorted it out' });
    expect(cancelled.statusCode).toBe(200);
    expect((await accept(helper, id)).statusCode).toBe(404);

    // ASSIGN is unchanged: a request reaching MATCHING still needs a consent evaluation.
    const second = await submitForm(requester);
    await pool().query(
      `UPDATE service_requests SET status = 'MATCHING' WHERE service_request_id = $1`,
      [second.id],
    );
    await expect(
      executeServiceRequestCommand(pool(), {
        tenantId,
        serviceRequestId: second.id,
        command: 'ASSIGN',
        actorId: requester.userId,
        actorType: 'SYSTEM',
        granteeId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DisclosureGuardRequiredError);
  });
});

describe('commands that need a reason', () => {
  it('answers 400 VALIDATION_FAILED, not 500, when CANCEL has no reason', async () => {
    const requester = await person(randomUUID(), { verified: true, county: 'SANTA_CLARA' });
    const { id } = await submitForm(requester);
    const refused = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${id}/commands/CANCEL`,
      headers: keyed(requester),
      payload: {},
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.code).toBe('VALIDATION_FAILED');
    expect(refused.json().error.message).toContain('requires a reason');
    expect((await getJson(`/api/v0/service-requests/${id}`, requester)).json().status).toBe(
      'SUBMITTED',
    );
  });
});

describe('me.active_qrf covers every category', () => {
  it.each(['FOOD', 'TRANSPORTATION', 'SHELTER', 'PEER_SUPPORT'] as const)(
    'names an open %s request, then the helper who accepted it',
    async (category) => {
      const tenantId = randomUUID();
      const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
      const helper = await person(tenantId, { county: 'SANTA_CLARA' });
      const { id } = await submitForm(requester, { category });

      const open = await getJson('/api/v0/veterans/me', requester);
      expect(open.json().active_qrf).toMatchObject({
        service_request_id: id,
        state: 'REQUESTED',
      });

      expect((await accept(helper, id)).statusCode).toBe(200);
      const accepted = await getJson('/api/v0/veterans/me', requester);
      expect(accepted.json().active_qrf).toMatchObject({
        service_request_id: id,
        state: 'RESPONDER_ACCEPTED',
      });
    },
  );

  it('keeps a second request of a held case readable as still waiting', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, { verified: true, county: 'SANTA_CLARA' });
    const helper = await person(tenantId, { county: 'SANTA_CLARA' });
    const first = await submitForm(requester, { category: 'FOOD' });
    expect((await accept(helper, first.id)).statusCode).toBe(200);

    // The newest request is a different one, so the helper on the first must not make it
    // read as accepted.
    const second = await submitForm(requester, { category: 'TRANSPORTATION' });
    const me = await getJson('/api/v0/veterans/me', requester);
    expect(me.json().active_qrf).toMatchObject({
      service_request_id: second.id,
      state: 'REQUESTED',
    });
  });
});
