/**
 * 72-hour request expiry (requires PostgreSQL).
 *
 * suas-specs V1_MVP_PROPOSAL.md R8.4: a request nobody accepted within the TTL expires,
 * as System, with an in-app notice to the requester. An accepted or fresh request never
 * expires. AGENTS.md rule 9: the sweep is replay-safe.
 *
 * Requests are aged by backdating `submitted_at` against the real clock, so the sweep
 * never touches other test files' fresh requests in the shared database.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import {
  expireDueRequests,
  InvalidRequestExpiryError,
  readRequestExpiryHours,
} from '../../src/coordination/expiry.js';
import { repairMissedRequestNotices } from '../../src/coordination/request-notices.js';
import type { Queryable } from '../../src/db/transaction.js';
import { appPool, createPerson, keyed } from '../helpers/actors.js';
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

interface Person {
  readonly userId: string;
  readonly headers: Record<string, string>;
}

/** A signed-in, verified Veteran in Santa Clara. */
const person = (tenantId: string, label: string) =>
  createPerson(app, { tenantId, label, county: 'SANTA_CLARA', verified: true });

/** A submitted request whose submission was `waitedHours` ago. */
async function submittedRequest(requester: Person, waitedHours: number): Promise<string> {
  const opened = await app.server.inject({
    method: 'POST',
    url: '/api/v0/cases',
    headers: keyed(requester),
  });
  expect([200, 201]).toContain(opened.statusCode);
  const created = await app.server.inject({
    method: 'POST',
    url: `/api/v0/cases/${opened.json().case_id}/service-requests`,
    headers: keyed(requester),
    payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
  });
  expect(created.statusCode).toBe(201);
  const serviceRequestId: string = created.json().service_request_id;
  const submitted = await app.server.inject({
    method: 'POST',
    url: `/api/v0/service-requests/${serviceRequestId}/commands/SUBMIT`,
    headers: keyed(requester),
    payload: {},
  });
  expect(submitted.statusCode).toBe(200);
  await appPool(app).query(
    `UPDATE service_requests SET submitted_at = now() - make_interval(hours => $2)
      WHERE service_request_id = $1`,
    [serviceRequestId, waitedHours],
  );
  return serviceRequestId;
}

async function statusOf(serviceRequestId: string) {
  const result = await appPool(app).query<{ status: string; terminal_at: Date | null }>(
    `SELECT status, terminal_at FROM service_requests WHERE service_request_id = $1`,
    [serviceRequestId],
  );
  return result.rows[0];
}

async function noticesFor(serviceRequestId: string) {
  const result = await appPool(app).query<{
    recipient_user_id: string;
    channel: string;
    reason: string;
    delivery_status: string;
    sent: boolean;
  }>(
    `SELECT recipient_user_id, channel, reason, delivery_status, sent_at IS NOT NULL AS sent
       FROM notifications WHERE subject_id = $1`,
    [serviceRequestId],
  );
  return result.rows;
}

describe('the 72-hour boundary', () => {
  it('expires a due request as System and tells the requester once', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const due = await submittedRequest(requester, 73);

    const result = await expireDueRequests(appPool(app));
    expect(result.ttlHours).toBe(72);
    expect(result.noticeFailures).toBe(0);
    expect(result.expired.map((item) => item.serviceRequestId)).toContain(due);

    const row = await statusOf(due);
    expect(row?.status).toBe('EXPIRED');
    expect(row?.terminal_at).not.toBeNull();
    expect(await noticesFor(due)).toEqual([
      {
        recipient_user_id: requester.userId,
        channel: 'IN_APP',
        reason: 'service_request_expired',
        // C-01: delivered, not left waiting to send (DISPATCH.md §14.6).
        delivery_status: 'SENT',
        sent: true,
      },
    ]);
    const audit = await appPool(app).query(
      `SELECT actor_type FROM audit_events
        WHERE event_type = 'SERVICE_REQUEST_EXPIRED' AND target_id = $1`,
      [due],
    );
    expect(audit.rows).toEqual([{ actor_type: 'SYSTEM' }]);
  });

  it('leaves a request inside the TTL and an accepted one untouched', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const helper = await person(tenantId, 'helper');
    const fresh = await submittedRequest(requester, 71);
    // A separate requester keeps the accepted request apart from the fresh one.
    const otherRequester = await person(tenantId, 'requester2');
    const accepted = await submittedRequest(otherRequester, 100);
    const accept = await app.server.inject({
      method: 'POST',
      url: `/api/v0/service-requests/${accepted}/accept`,
      headers: helper.headers,
    });
    expect(accept.statusCode).toBe(200);

    await expireDueRequests(appPool(app));

    expect((await statusOf(fresh))?.status).toBe('SUBMITTED');
    expect((await statusOf(accepted))?.status).toBe('ACCEPTED');
    expect(await noticesFor(fresh)).toEqual([]);
    expect(await noticesFor(accepted)).toEqual([]);
  });

  it('expires an assigned request nobody accepted, and not a draft with no submit time', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const assigned = await submittedRequest(requester, 73);
    await appPool(app).query(
      `UPDATE service_requests SET status = 'ASSIGNED' WHERE service_request_id = $1`,
      [assigned],
    );

    const opened = await app.server.inject({
      method: 'POST',
      url: '/api/v0/cases',
      headers: keyed(requester),
    });
    expect([200, 201]).toContain(opened.statusCode);
    const draft = await app.server.inject({
      method: 'POST',
      url: `/api/v0/cases/${opened.json().case_id}/service-requests`,
      headers: keyed(requester),
      payload: { category: 'FOOD', details: { meeting_place: 'Main Street library' } },
    });
    expect(draft.statusCode).toBe(201);
    const draftId: string = draft.json().service_request_id;
    await appPool(app).query(
      `UPDATE service_requests SET created_at = now() - interval '10 days'
        WHERE service_request_id = $1`,
      [draftId],
    );

    await expireDueRequests(appPool(app));

    expect((await statusOf(assigned))?.status).toBe('EXPIRED');
    expect((await statusOf(draftId))?.status).toBe('CREATED');
    expect(await noticesFor(draftId)).toEqual([]);
  });

  it('is safe to replay and to run twice at once: one expiry, one notice', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const due = await submittedRequest(requester, 80);

    const runs = await Promise.all([
      expireDueRequests(appPool(app)),
      expireDueRequests(appPool(app)),
    ]);
    const expiredBy = runs.filter((run) =>
      run.expired.some((item) => item.serviceRequestId === due),
    );
    expect(expiredBy).toHaveLength(1);
    const replay = await expireDueRequests(appPool(app));
    expect(replay.expired.map((item) => item.serviceRequestId)).not.toContain(due);

    expect(await noticesFor(due)).toHaveLength(1);
    const audit = await appPool(app).query(
      `SELECT 1 FROM audit_events
        WHERE event_type = 'SERVICE_REQUEST_EXPIRED' AND target_id = $1`,
      [due],
    );
    expect(audit.rowCount).toBe(1);
  });
});

describe('a lost expiry notice (A2-11)', () => {
  it('is written by the repair sweep, delivered, and only once', async () => {
    const tenantId = randomUUID();
    const requester = await person(tenantId, 'requester');
    const due = await submittedRequest(requester, 74);
    await expireDueRequests(appPool(app));
    // The post-commit notice write failed.
    await appPool(app).query('DELETE FROM notifications WHERE subject_id = $1', [due]);

    await repairMissedRequestNotices(appPool(app));
    await repairMissedRequestNotices(appPool(app));

    expect(await noticesFor(due)).toEqual([
      {
        recipient_user_id: requester.userId,
        channel: 'IN_APP',
        reason: 'service_request_expired',
        delivery_status: 'SENT',
        sent: true,
      },
    ]);
  });
});

describe('the stored TTL', () => {
  const reading = (value: unknown): Queryable =>
    ({ query: () => Promise.resolve({ rows: value === undefined ? [] : [{ value }] }) }) as never;

  it('reads a whole number of hours and fails closed on anything else', async () => {
    expect(await readRequestExpiryHours(reading(72))).toBe(72);
    for (const bad of [undefined, 0, -3, 1.5, '72', null]) {
      await expect(readRequestExpiryHours(reading(bad)), String(bad)).rejects.toBeInstanceOf(
        InvalidRequestExpiryError,
      );
    }
  });
});
