/**
 * Intake Assistant over HTTP (requires PostgreSQL): draft, edit, submit, the
 * out-of-scope and fallback paths, the verified-Veteran gate, and that intake text
 * is never logged. V1_PROJECT_PLAN.md §2.1 / F3; AGENTS.md rule 14.
 */

import { randomUUID } from 'node:crypto';
import type * as nodeFsType from 'node:fs';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { withTransaction } from '../../src/db/index.js';
import { createResource, setResourceActive, verifyResource } from '../../src/fulfillment/index.js';
import type { ScriptedModelInference } from '../../src/inference/index.js';
import { type ModelToolCall } from '../../src/inference/index.js';
import { createUser } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

let app: StartedApp;
let model: ScriptedModelInference;

beforeAll(async () => {
  app = await startApp({
    env: validEnv({
      SUAS_MIGRATIONS_MODE: 'apply',
      DATABASE_URL: testDatabaseUrl(),
      SUAS_MODEL_INFERENCE_MODE: 'fake',
      SUAS_LOG_LEVEL: 'debug',
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

async function veteran(options: { verified?: boolean } = {}) {
  const tenantId = randomUUID();
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  if (options.verified !== false) await markVerifiedVeteran(pool(), tenantId, user.userId);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return { tenantId, user, headers: { authorization: `Bearer ${session.credential}` } };
}

const toolTurn = (...calls: ModelToolCall[]) => ({ ok: true as const, text: '', toolCalls: calls });
const textTurn = (text: string) => ({ ok: true as const, text, toolCalls: [] });
const draftTool = (input: Record<string, unknown>): ModelToolCall => ({
  id: 'd1',
  name: 'draft_service_request',
  input,
});

async function post(
  url: string,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return app.server.inject({ method: 'POST', url, headers: { ...headers, ...extra }, payload });
}

describe('draft, edit and submit', () => {
  it('turns a message into a draft the Veteran edits and submits', async () => {
    const { headers, tenantId, user } = await veteran();
    model.enqueue(
      toolTurn(
        draftTool({
          category: 'FOOD',
          summary: 'Groceries for the week',
          timing: 'Friday',
          meeting_place: 'Front steps of the library',
        }),
      ),
      textTurn('I drafted a food request. Check it before you submit.'),
    );
    const created = await post('/api/v0/intake/drafts', headers, {
      text: 'I need groceries by Friday.',
    });
    expect(created.statusCode).toBe(201);
    const turn = created.json();
    expect(turn.outcome).toBe('DRAFT_READY');
    expect(turn.draft).toMatchObject({
      status: 'DRAFT',
      category: 'FOOD',
      timing: 'Friday',
      meeting_place: 'Front steps of the library',
    });
    const draftId: string = turn.draft.draft_id;

    // Nothing exists as a Service Request until the Veteran submits.
    const before = await pool().query(
      `SELECT count(*)::int AS n FROM service_requests WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(before.rows[0].n).toBe(0);

    const edited = await app.server.inject({
      method: 'PATCH',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers,
      payload: {
        category: 'TRANSPORTATION',
        summary: 'Ride to the food bank',
        timing: null,
        meeting_place: 'Corner of Elm and 3rd',
      },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      category: 'TRANSPORTATION',
      timing: null,
      meeting_place: 'Corner of Elm and 3rd',
    });

    const submitted = await post(
      `/api/v0/intake/drafts/${draftId}/submit`,
      headers,
      {},
      {
        'idempotency-key': 'submit-1',
      },
    );
    expect(submitted.statusCode).toBe(201);
    const body = submitted.json();
    expect(body.service_request).toMatchObject({ category: 'TRANSPORTATION', status: 'SUBMITTED' });
    expect(body.draft).toMatchObject({
      status: 'SUBMITTED',
      service_request_id: body.service_request.service_request_id,
    });

    // The request carries the reviewed fields, not the typed text.
    const stored = await pool().query(
      `SELECT details, created_by FROM service_requests WHERE service_request_id = $1`,
      [body.service_request.service_request_id],
    );
    expect(stored.rows[0].details).toEqual({
      summary: 'Ride to the food bank',
      meeting_place: 'Corner of Elm and 3rd',
    });
    expect(stored.rows[0].created_by).toBe(user.userId);

    const replay = await post(
      `/api/v0/intake/drafts/${draftId}/submit`,
      headers,
      {},
      {
        'idempotency-key': 'submit-1',
      },
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);

    const again = await post(
      `/api/v0/intake/drafts/${draftId}/submit`,
      headers,
      {},
      {
        'idempotency-key': 'submit-2',
      },
    );
    expect(again.statusCode).toBe(409);
    const late = await app.server.inject({
      method: 'PATCH',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers,
      payload: { summary: 'changed' },
    });
    expect(late.statusCode).toBe(409);
  });

  it('adds a follow-up message and keeps the draft for the owner only', async () => {
    const { headers } = await veteran();
    const other = await veteran();
    model.enqueue(textTurn('What kind of help do you need?'));
    const first = await post('/api/v0/intake/drafts', headers, { text: 'Things are hard.' });
    expect(first.json()).toMatchObject({ outcome: 'NO_DRAFT', draft: { category: null } });
    const draftId: string = first.json().draft.draft_id;

    model.enqueue(
      toolTurn(
        draftTool({ category: 'PEER_SUPPORT', summary: 'Wants to talk to another veteran' }),
      ),
      textTurn('Drafted.'),
    );
    const next = await post(`/api/v0/intake/drafts/${draftId}/messages`, headers, {
      text: 'I want to talk to another veteran.',
    });
    expect(next.statusCode).toBe(200);
    expect(next.json().draft.category).toBe('PEER_SUPPORT');
    const read = await app.server.inject({
      method: 'GET',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers,
    });
    expect(read.json().intake_text).toBe('Things are hard.\n\nI want to talk to another veteran.');

    const stranger = await app.server.inject({
      method: 'GET',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers: other.headers,
    });
    expect(stranger.statusCode).toBe(404);
  });

  it('refuses to submit a draft with no category', async () => {
    const { headers } = await veteran();
    model.enqueue(textTurn('Tell me more.'));
    const first = await post('/api/v0/intake/drafts', headers, { text: 'Help.' });
    const res = await post(
      `/api/v0/intake/drafts/${first.json().draft.draft_id}/submit`,
      headers,
      {},
      { 'idempotency-key': 'k' },
    );
    expect(res.statusCode).toBe(422);
  });
});

describe('needs outside the four categories', () => {
  it('says not available yet, drafts nothing and lists matching Resources', async () => {
    const { headers, tenantId, user } = await veteran();
    const created = await createResource(pool(), {
      tenantId,
      serviceName: 'Example Job Help',
      category: 'PEER_SUPPORT',
      eligibility: 'job search help',
    });
    await withTransaction(pool(), async (tx) => {
      await verifyResource(tx, {
        tenantId,
        resourceId: created.resourceId,
        verificationSource: 'synthetic-intake-test',
        actorId: user.userId,
      });
      await setResourceActive(tx, {
        tenantId,
        resourceId: created.resourceId,
        active: true,
        actorId: user.userId,
      });
    });
    model.enqueue(
      toolTurn({
        id: 's1',
        name: 'search_resources',
        input: { keywords: 'job', outside_categories: true },
      }),
      textTurn('I cannot take job requests yet. These Resources may help.'),
    );
    const res = await post('/api/v0/intake/drafts', headers, { text: 'I need a job.' });
    expect(res.statusCode).toBe(201);
    const body = res.json<{
      notice: string;
      draft: { category: string | null };
      resources: { service_name: string }[];
    }>();
    expect(body).toMatchObject({ outcome: 'NO_DRAFT', not_available_yet: true });
    expect(body.notice).toContain('cannot take requests for that need yet');
    expect(body.draft.category).toBeNull();
    expect(body.resources.map((r) => r.service_name)).toEqual(['Example Job Help']);
  });
});

describe('fallback to the plain form', () => {
  it.each([
    ['a timeout', { ok: false as const, failure: 'timeout' as const }],
    ['an empty script (port unavailable)', undefined],
  ])('stores nothing and points to the form after %s', async (_name, failure) => {
    const { headers, tenantId } = await veteran();
    if (failure !== undefined) model.enqueue(failure);
    const res = await post('/api/v0/intake/drafts', headers, { text: 'I need a ride.' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      outcome: 'FALLBACK_FORM',
      draft: null,
      request_form: { method: 'POST', path: '/api/v0/service-requests' },
    });
    const rows = await pool().query(
      `SELECT count(*)::int AS n FROM service_request_drafts WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(rows.rows[0].n).toBe(0);

    const form = await post(
      '/api/v0/service-requests',
      headers,
      {
        category: 'TRANSPORTATION',
        summary: 'A ride to the clinic',
        meeting_place: 'Clinic main entrance',
      },
      { 'idempotency-key': 'form-1' },
    );
    expect(form.statusCode).toBe(201);
    expect(form.json()).toMatchObject({ category: 'TRANSPORTATION', status: 'SUBMITTED' });
  });

  it('keeps the draft unchanged when a follow-up fails', async () => {
    const { headers } = await veteran();
    model.enqueue(
      toolTurn(draftTool({ category: 'FOOD', summary: 'Groceries' })),
      textTurn('Drafted.'),
    );
    const first = await post('/api/v0/intake/drafts', headers, { text: 'Groceries please.' });
    const draftId: string = first.json().draft.draft_id;
    model.enqueue({ ok: false, failure: 'unavailable' });
    const next = await post(`/api/v0/intake/drafts/${draftId}/messages`, headers, {
      text: 'More.',
    });
    expect(next.json()).toMatchObject({ outcome: 'FALLBACK_FORM', draft: { category: 'FOOD' } });
    const read = await app.server.inject({
      method: 'GET',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers,
    });
    expect(read.json().intake_text).toBe('Groceries please.');
  });

  it('reports availability', async () => {
    const { headers } = await veteran();
    const res = await app.server.inject({ method: 'GET', url: '/api/v0/intake/status', headers });
    expect(res.json()).toMatchObject({ assistant_available: true });
  });
});

describe('verified-Veteran gate', () => {
  it('refuses every requester route to someone who has not passed the ID scan', async () => {
    const { headers } = await veteran({ verified: false });
    const id = randomUUID();
    const calls = [
      app.server.inject({ method: 'GET', url: '/api/v0/intake/status', headers }),
      post('/api/v0/intake/drafts', headers, { text: 'I need food.' }),
      post(`/api/v0/intake/drafts/${id}/messages`, headers, { text: 'More.' }),
      app.server.inject({ method: 'GET', url: `/api/v0/intake/drafts/${id}`, headers }),
      app.server.inject({
        method: 'PATCH',
        url: `/api/v0/intake/drafts/${id}`,
        headers,
        payload: { summary: 'x' },
      }),
      post(`/api/v0/intake/drafts/${id}/submit`, headers, {}, { 'idempotency-key': 'k' }),
      post(
        '/api/v0/service-requests',
        headers,
        { category: 'FOOD', summary: 'Food' },
        { 'idempotency-key': 'k' },
      ),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('VERIFICATION_REQUIRED');
    }
    // The model was never asked.
    expect(model.requests().every((r) => !JSON.stringify(r).includes('I need food.'))).toBe(true);
  });

  it('requires a session', async () => {
    const res = await app.server.inject({ method: 'GET', url: '/api/v0/intake/status' });
    expect(res.statusCode).toBe(401);
  });
});

describe('intake text is never logged', () => {
  it('writes the typed text to no log or console, on success or failure', async () => {
    const MARKER = `zz-private-${randomUUID()}`;
    const { headers } = await veteran();
    const written: string[] = [];
    const nodeFs = createRequire(import.meta.url)('node:fs') as typeof nodeFsType;
    const grab = (chunk: unknown) => written.push(String(chunk));
    const spies = [
      vi.spyOn(nodeFs, 'writeSync').mockImplementation((_fd: number, data: unknown) => {
        grab(data);
        return String(data).length;
      }),
      // pino's SonicBoom writes the log lines through fs.write or fs.writeSync.
      vi.spyOn(nodeFs, 'write').mockImplementation((...args: unknown[]) => {
        const data = args[1];
        grab(data);
        const done = args.find((arg) => typeof arg === 'function') as (
          error: null,
          bytes: number,
        ) => void;
        done(null, Buffer.byteLength(String(data)));
      }),
      vi.spyOn(process.stdout, 'write').mockImplementation((data: unknown) => {
        grab(data);
        return true;
      }),
      vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown) => {
        grab(data);
        return true;
      }),
    ];
    try {
      model.enqueue(
        toolTurn(draftTool({ category: 'FOOD', summary: 'Groceries' })),
        textTurn('Ok.'),
      );
      const ok = await post('/api/v0/intake/drafts', headers, { text: `Food please ${MARKER}` });
      expect(ok.statusCode).toBe(201);
      // The meeting place is on the same footing: it is stored, never logged.
      const form = await post(
        '/api/v0/service-requests',
        headers,
        { category: 'FOOD', summary: 'Food', meeting_place: `Library ${MARKER}` },
        { 'idempotency-key': 'log-form' },
      );
      expect(form.statusCode).toBe(201);
      model.enqueue({ ok: false, failure: 'invalid' });
      await post('/api/v0/intake/drafts', headers, { text: `Again ${MARKER}` });
      // A port that throws with the text in its message must not reach the logs either.
      const original = model.converse.bind(model);
      model.converse = () => Promise.reject(new Error(`provider quoted ${MARKER}`));
      await post('/api/v0/intake/drafts', headers, { text: `Thrown ${MARKER}` });
      model.converse = original;
      // An over-long message is a 400 and must not echo the text either.
      const tooLong = await post('/api/v0/intake/drafts', headers, {
        text: `${MARKER} ${'x'.repeat(3000)}`,
      });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.body).not.toContain(MARKER);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    // Positive control: the spies did see the request log lines.
    expect(written.join('').length).toBeGreaterThan(0);
    expect(written.join('')).not.toContain(MARKER);
  });
});

describe('ride destination on a draft (R8.7)', () => {
  it('is drafted for a ride and refused when the category changes', async () => {
    const { headers } = await veteran();
    model.enqueue(
      toolTurn(
        draftTool({
          category: 'TRANSPORTATION',
          summary: 'Ride to the clinic',
          meeting_place: 'Front door',
          destination: 'County clinic',
        }),
      ),
      textTurn('Drafted.'),
    );
    const created = await post('/api/v0/intake/drafts', headers, { text: 'I need a ride.' });
    expect(created.json().draft.destination).toBe('County clinic');
    const draftId: string = created.json().draft.draft_id;

    const toFood = await app.server.inject({
      method: 'PATCH',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers,
      payload: { category: 'FOOD' },
    });
    expect(toFood.statusCode).toBe(422);

    const cleared = await app.server.inject({
      method: 'PATCH',
      url: `/api/v0/intake/drafts/${draftId}`,
      headers,
      payload: { category: 'FOOD', destination: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ category: 'FOOD', destination: null });
  });
});
