/**
 * Trusted Circle JSON API (requires PostgreSQL).
 *
 * SUAS-specs TRUSTED_CIRCLE.md §1–§3; API.md §4; PRIVACY.md.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createUser, setUserDisplayName, setUserStatus } from '../../src/identity/index.js';
import {
  INVITE_LIMIT_PER_ADDRESS,
  INVITE_LIMIT_PER_VETERAN,
} from '../../src/http/routes/trusted-contacts.js';
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

function requirePool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

async function auditActions(tenantId: string, trustedContactId: string): Promise<string[]> {
  const result = await requirePool().query<{ action: string }>(
    `SELECT action FROM audit_events
      WHERE tenant_id = $1 AND target_type = 'TrustedContact' AND target_id = $2
      ORDER BY occurred_at`,
    [tenantId, trustedContactId],
  );
  return result.rows.map((row) => row.action);
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
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  return {
    tenantId,
    user,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

/** POST an invite; API.md §7 requires an Idempotency-Key on this create. */
function invite(headers: Record<string, string>, payload: object, key = `invite-${randomUUID()}`) {
  return app.server.inject({
    method: 'POST',
    url: '/api/v0/trusted-contacts',
    headers: { ...headers, 'idempotency-key': key },
    payload,
  });
}

describe('GET/POST /api/v0/trusted-contacts', () => {
  it('requires authentication', async () => {
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/trusted-contacts',
    });
    expect(response.statusCode).toBe(401);
  });

  it('invites and lists contacts without invite channel literals', async () => {
    const { headers } = await veteranSession();
    const inviteEmail = syntheticEmail(`buddy-${randomUUID().slice(0, 8)}`);
    const created = await invite(headers, {
      relationship_label: 'Battle buddy',
      invite_email: inviteEmail,
    });
    expect(created.statusCode).toBe(201);
    const { replayed, ...contact } = created.json();
    expect(replayed).toBe(false);
    expect(contact).toMatchObject({
      relationship_label: 'Battle buddy',
      status: 'INVITED',
      contact_user_id: null,
    });
    expect(contact).not.toHaveProperty('invite_email');
    expect(created.body).not.toContain(inviteEmail);

    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/trusted-contacts',
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().trusted_contacts).toEqual([contact]);
  });

  it('does not leak another veteran roster', async () => {
    const a = await veteranSession();
    const b = await veteranSession();
    await invite(a.headers, {
      relationship_label: 'Private',
      invite_email: syntheticEmail(`a-${randomUUID().slice(0, 8)}`),
    });
    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/trusted-contacts',
      headers: b.headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().trusted_contacts).toEqual([]);
  });

  it('removes an owned contact', async () => {
    const { headers, tenantId } = await veteranSession();
    const created = await invite(headers, {
      relationship_label: 'Remove me',
      invite_email: syntheticEmail(`rm-${randomUUID().slice(0, 8)}`),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().trusted_contact_id as string;
    const removed = await app.server.inject({
      method: 'POST',
      url: `/api/v0/trusted-contacts/${id}/commands/remove`,
      headers,
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().status).toBe('REMOVED');
    // TRUSTED_CIRCLE.md §7: the removal is audited.
    expect(await auditActions(tenantId, id)).toEqual([
      'INVITE_TRUSTED_CONTACT',
      'REMOVE_TRUSTED_CONTACT',
    ]);
  });

  it('requires an Idempotency-Key and replays a retried invite (API.md §7)', async () => {
    const { headers, tenantId } = await veteranSession();
    const payload = {
      relationship_label: 'Retry buddy',
      invite_email: syntheticEmail(`retry-${randomUUID().slice(0, 8)}`),
    };
    const missing = await app.server.inject({
      method: 'POST',
      url: '/api/v0/trusted-contacts',
      headers,
      payload,
    });
    expect(missing.statusCode).toBe(400);

    const key = `invite-${randomUUID()}`;
    const first = await invite(headers, payload, key);
    const retry = await invite(headers, payload, key);
    expect(first.statusCode).toBe(201);
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toEqual({ ...first.json(), replayed: true });

    const conflict = await invite(headers, { ...payload, relationship_label: 'Other' }, key);
    expect(conflict.statusCode).toBe(409);

    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/trusted-contacts',
      headers,
    });
    expect(listed.json().trusted_contacts).toHaveLength(1);

    // TRUSTED_CIRCLE.md §3.4: one TRUSTED_CONTACT_INVITED, carrying no invite address.
    const id = first.json().trusted_contact_id as string;
    const events = await requirePool().query<{ payload: object }>(
      `SELECT payload FROM domain_events
        WHERE tenant_id = $1 AND aggregate_id = $2 AND event_type = 'TRUSTED_CONTACT_INVITED'`,
      [tenantId, id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.payload).toEqual({ status: 'INVITED', channels: ['EMAIL'] });
    expect(await auditActions(tenantId, id)).toEqual(['INVITE_TRUSTED_CONTACT']);
  });
});

describe('invite delivery and the invitee read (R9.4)', () => {
  async function signedIn(tenantId: string, email: string) {
    const user = await createUser(requirePool(), { tenantId, email, status: 'ACTIVE' });
    const session = await createSession(requirePool(), TEST_SESSION_SECRET, {
      tenantId,
      userId: user.userId,
    });
    return { user, headers: { authorization: `Bearer ${session.credential}` } };
  }

  it('sends one EMAIL to the invited address, recording the template version', async () => {
    const { headers, tenantId } = await veteranSession();
    const email = syntheticEmail(`invitee-${randomUUID().slice(0, 8)}`);
    const key = `invite-${randomUUID()}`;
    const first = await invite(headers, { relationship_label: 'Sister', invite_email: email }, key);
    await invite(headers, { relationship_label: 'Sister', invite_email: email }, key);
    const phoneOnly = await invite(headers, {
      relationship_label: 'Brother',
      invite_phone: '+15555550123',
    });
    expect(phoneOnly.statusCode).toBe(201);

    const sends = await requirePool().query<{
      destination: string;
      reason: string;
      channel: string;
      template_version: string;
      subject_id: string;
      recipient_user_id: string | null;
    }>(
      `SELECT destination, reason, channel, template_version, subject_id, recipient_user_id
         FROM notifications WHERE tenant_id = $1 AND reason = 'trusted_contact_invited'`,
      [tenantId],
    );
    expect(sends.rows).toEqual([
      {
        destination: email,
        reason: 'trusted_contact_invited',
        channel: 'EMAIL',
        template_version: 'invite@1',
        subject_id: first.json().trusted_contact_id,
        recipient_user_id: null,
      },
    ]);
  });

  it('shows the invitee display name and relationship only, then nothing once accepted', async () => {
    const { headers, tenantId, user } = await veteranSession();
    await setUserDisplayName(requirePool(), tenantId, user.userId, 'Marcus T.');
    const email = syntheticEmail(`invitee-${randomUUID().slice(0, 8)}`);
    const created = await invite(headers, { relationship_label: 'Sister', invite_email: email });
    const id = created.json().trusted_contact_id as string;
    const invitee = await signedIn(tenantId, email.toUpperCase());
    const bystander = await signedIn(tenantId, syntheticEmail(`other-${randomUUID().slice(0, 8)}`));

    const read = (auth: Record<string, string>) =>
      app.server.inject({
        method: 'GET',
        url: '/api/v0/trusted-contacts/invitations',
        headers: auth,
      });
    expect(
      (await app.server.inject({ method: 'GET', url: '/api/v0/trusted-contacts/invitations' }))
        .statusCode,
    ).toBe(401);
    expect((await read(invitee.headers)).json()).toEqual({
      invitations: [
        { trusted_contact_id: id, veteran_display_name: 'Marcus T.', relationship_label: 'Sister' },
      ],
    });
    expect((await read(bystander.headers)).json()).toEqual({ invitations: [] });
    // The Veteran never sees their own invite as one to accept.
    expect((await read(headers)).json()).toEqual({ invitations: [] });

    const accepted = await app.server.inject({
      method: 'POST',
      url: `/api/v0/trusted-contacts/${id}/commands/accept`,
      headers: { ...invitee.headers, 'idempotency-key': randomUUID() },
    });
    expect(accepted.json().status).toBe('ACCEPTED');
    expect((await read(invitee.headers)).json()).toEqual({ invitations: [] });
  });

  it('hides an invite once the inviting Veteran is no longer ACTIVE', async () => {
    const { headers, tenantId, user } = await veteranSession();
    const email = syntheticEmail(`invitee-${randomUUID().slice(0, 8)}`);
    await invite(headers, { relationship_label: 'Friend', invite_email: email });
    const invitee = await signedIn(tenantId, email);
    const read = async () =>
      (
        await app.server.inject({
          method: 'GET',
          url: '/api/v0/trusted-contacts/invitations',
          headers: invitee.headers,
        })
      ).json().invitations as unknown[];
    expect(await read()).toHaveLength(1);
    await setUserStatus(requirePool(), tenantId, user.userId, 'SUSPENDED');
    expect(await read()).toEqual([]);
  });
});

describe('invite abuse controls', () => {
  async function inviteSends(tenantId: string): Promise<number> {
    const result = await requirePool().query(
      `SELECT 1 FROM notifications WHERE tenant_id = $1 AND reason = 'trusted_contact_invited'`,
      [tenantId],
    );
    return result.rowCount ?? 0;
  }

  it('returns the open invite for an address the Veteran already invited and sends nothing more', async () => {
    const { headers, tenantId } = await veteranSession();
    const email = syntheticEmail(`again-${randomUUID().slice(0, 8)}`);
    const first = await invite(headers, { relationship_label: 'Sister', invite_email: email });
    const second = await invite(headers, {
      relationship_label: 'Sis',
      invite_email: email.toUpperCase(),
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ...first.json(), replayed: false });
    expect(await inviteSends(tenantId)).toBe(1);
  });

  it('limits one Veteran re-inviting an address, with a 429 and Retry-After, and nobody else', async () => {
    const email = syntheticEmail(`target-${randomUUID().slice(0, 8)}`);
    const a = await veteranSession();
    // Invite, remove, invite again: each new invite to the address counts for this Veteran.
    for (let n = 0; n < INVITE_LIMIT_PER_ADDRESS.limit; n += 1) {
      const sent = await invite(a.headers, { relationship_label: 'Friend', invite_email: email });
      expect(sent.statusCode).toBe(201);
      await app.server.inject({
        method: 'POST',
        url: `/api/v0/trusted-contacts/${String(sent.json().trusted_contact_id)}/commands/remove`,
        headers: a.headers,
      });
    }
    const refused = await invite(a.headers, { relationship_label: 'Friend', invite_email: email });
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.body).not.toContain(email);

    // Veteran B sees exactly what a first invite to a fresh address gets: no oracle.
    const b = await veteranSession();
    const toTaken = await invite(b.headers, { relationship_label: 'Friend', invite_email: email });
    const toFresh = await invite(b.headers, {
      relationship_label: 'Friend',
      invite_email: syntheticEmail(`fresh-${randomUUID().slice(0, 8)}`),
    });
    expect(toTaken.statusCode).toBe(201);
    expect(toFresh.statusCode).toBe(201);
    const shape = (body: Record<string, unknown>) => ({ ...body, trusted_contact_id: 'id' });
    expect(shape(toTaken.json())).toEqual(shape(toFresh.json()));
    expect(await inviteSends(b.tenantId)).toBe(2);
  });

  it('limits how many invites one Veteran sends', async () => {
    const { headers, tenantId } = await veteranSession();
    const send = () =>
      invite(headers, {
        relationship_label: 'Friend',
        invite_email: syntheticEmail(`many-${randomUUID().slice(0, 8)}`),
      });
    for (let n = 0; n < INVITE_LIMIT_PER_VETERAN.limit; n += 1) {
      expect((await send()).statusCode).toBe(201);
    }
    expect((await send()).statusCode).toBe(429);
    expect(await inviteSends(tenantId)).toBe(INVITE_LIMIT_PER_VETERAN.limit);
  });
});
