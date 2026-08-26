/**
 * Trusted Circle JSON API (requires PostgreSQL).
 *
 * SUAS-specs TRUSTED_CIRCLE.md §1–§3; API.md §4; PRIVACY.md.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import { createUser } from '../../src/identity/index.js';
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

async function veteranSession() {
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
  return {
    tenantId,
    user,
    headers: { authorization: `Bearer ${session.credential}` },
  };
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
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/v0/trusted-contacts',
      headers,
      payload: {
        relationship_label: 'Battle buddy',
        invite_email: inviteEmail,
      },
    });
    expect(created.statusCode).toBe(201);
    const contact = created.json();
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
    await app.server.inject({
      method: 'POST',
      url: '/api/v0/trusted-contacts',
      headers: a.headers,
      payload: {
        relationship_label: 'Private',
        invite_email: syntheticEmail(`a-${randomUUID().slice(0, 8)}`),
      },
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
    const { headers } = await veteranSession();
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/v0/trusted-contacts',
      headers,
      payload: {
        relationship_label: 'Remove me',
        invite_email: syntheticEmail(`rm-${randomUUID().slice(0, 8)}`),
      },
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
  });
});
