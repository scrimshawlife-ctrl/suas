/**
 * Consent template admin API and published read (requires PostgreSQL).
 *
 * CONSENT.md §6, ADMIN.md §2, R9.3 (contributor proposal, specs #72). Proves: SUAS admin
 * plus MFA on the admin routes, server-numbered versions with an idempotent create,
 * publish supersedes the earlier version and is audited, a grant needs the current
 * version, and the published read for signed-in clients.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession, elevateSession } from '../../src/auth/index.js';
import { createUser, grantSuasAdmin } from '../../src/identity/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';
import { markVerifiedVeteran } from '../helpers/verified-veteran.js';

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

function pool() {
  if (app.pool === undefined) throw new Error('no pool');
  return app.pool;
}

async function credential(tenantId: string, options: { admin: boolean; elevate: boolean }) {
  const user = await createUser(pool(), {
    tenantId,
    email: syntheticEmail(`u-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
  });
  if (options.admin) await grantSuasAdmin(pool(), user.userId, undefined);
  else await markVerifiedVeteran(pool(), tenantId, user.userId);
  const session = await createSession(pool(), TEST_SESSION_SECRET, {
    tenantId,
    userId: user.userId,
  });
  if (options.elevate) await elevateSession(pool(), session.session.sessionId);
  return { userId: user.userId, headers: { authorization: `Bearer ${session.credential}` } };
}

const uniqueKey = () => `test-consent-${randomUUID().slice(0, 8)}`;

async function create(
  headers: Record<string, string>,
  templateKey: string,
  body: string,
  idempotencyKey: string = randomUUID(),
) {
  return app.server.inject({
    method: 'POST',
    url: '/api/v0/admin/consent-templates',
    headers: { ...headers, 'idempotency-key': idempotencyKey },
    payload: { template_key: templateKey, body },
  });
}

async function publish(headers: Record<string, string>, versionKey: string) {
  return app.server.inject({
    method: 'POST',
    url: `/api/v0/admin/consent-templates/${encodeURIComponent(versionKey)}/commands/publish`,
    headers,
  });
}

describe('access', () => {
  it('refuses unauthenticated, non-admin and unelevated-admin callers on the admin routes', async () => {
    const tenantId = randomUUID();
    const plain = await credential(tenantId, { admin: false, elevate: false });
    const unelevated = await credential(tenantId, { admin: true, elevate: false });
    const routes = [
      { method: 'GET', url: '/api/v0/admin/consent-templates' },
      { method: 'POST', url: '/api/v0/admin/consent-templates' },
      { method: 'POST', url: '/api/v0/admin/consent-templates/a-key@1/commands/publish' },
    ] as const;
    for (const route of routes) {
      expect((await app.server.inject({ ...route })).statusCode, route.url).toBe(401);
      const asPlain = await app.server.inject({ ...route, headers: plain.headers });
      expect(asPlain.statusCode, route.url).toBe(403);
      const asUnelevated = await app.server.inject({ ...route, headers: unelevated.headers });
      expect(asUnelevated.statusCode, route.url).toBe(403);
      expect(asUnelevated.json().error.code).toBe('MFA_REQUIRED');
    }
  });
});

describe('create and publish', () => {
  it('numbers versions, replays a retried create, supersedes on publish and audits both', async () => {
    const tenantId = randomUUID();
    const admin = await credential(tenantId, { admin: true, elevate: true });
    const templateKey = uniqueKey();

    const idempotencyKey = randomUUID();
    const first = await create(
      admin.headers,
      templateKey,
      'Synthetic test template, v1.',
      idempotencyKey,
    );
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      version_key: `${templateKey}@1`,
      version: 1,
      status: 'DRAFT',
      published_at: null,
      replayed: false,
    });
    const replay = await create(
      admin.headers,
      templateKey,
      'Synthetic test template, v1.',
      idempotencyKey,
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ version_key: `${templateKey}@1`, replayed: true });
    const conflict = await create(admin.headers, templateKey, 'Different text.', idempotencyKey);
    expect(conflict.statusCode).toBe(409);

    const v1 = await publish(admin.headers, `${templateKey}@1`);
    expect(v1.statusCode).toBe(200);
    expect(v1.json()).toMatchObject({ status: 'PUBLISHED', superseded_version_keys: [] });
    const again = await publish(admin.headers, `${templateKey}@1`);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('ILLEGAL_TRANSITION');

    const second = await create(admin.headers, templateKey, 'Synthetic test template, v2.');
    expect(second.json()).toMatchObject({ version_key: `${templateKey}@2`, version: 2 });
    const v2 = await publish(admin.headers, `${templateKey}@2`);
    expect(v2.json()).toMatchObject({
      status: 'PUBLISHED',
      superseded_version_keys: [`${templateKey}@1`],
    });

    const list = await app.server.inject({
      method: 'GET',
      url: '/api/v0/admin/consent-templates',
      headers: admin.headers,
    });
    const listed: { templates: { version_key: string; template_key: string; status: string }[] } =
      list.json();
    const mine = listed.templates.filter((template) => template.template_key === templateKey);
    expect(mine.map((template) => `${template.version_key}:${template.status}`)).toEqual([
      `${templateKey}@2:PUBLISHED`,
      `${templateKey}@1:SUPERSEDED`,
    ]);

    const audits = await pool().query<{ event_type: string; actor_id: string; payload: object }>(
      `SELECT event_type, actor_id, payload FROM audit_events
        WHERE tenant_id = $1 AND target_type = 'ConsentTemplateVersion'
        ORDER BY occurred_at, event_type`,
      [tenantId],
    );
    expect(audits.rows.map((row) => row.event_type)).toEqual([
      'CONSENT_TEMPLATE_VERSION_CREATED',
      'CONSENT_TEMPLATE_PUBLISHED',
      'CONSENT_TEMPLATE_VERSION_CREATED',
      'CONSENT_TEMPLATE_PUBLISHED',
    ]);
    expect(audits.rows.every((row) => row.actor_id === admin.userId)).toBe(true);
    // The copy stays on the template row; the audit carries key and version only.
    expect(JSON.stringify(audits.rows)).not.toContain('Synthetic test template');
  });

  it('answers 404 for an unknown version and 400 for a malformed key', async () => {
    const admin = await credential(randomUUID(), { admin: true, elevate: true });
    expect((await publish(admin.headers, `${uniqueKey()}@1`)).statusCode).toBe(404);
    expect((await publish(admin.headers, 'Not A Key')).statusCode).toBe(400);
    expect((await create(admin.headers, 'Bad Key', 'Text')).statusCode).toBe(400);
  });
});

describe('GET /api/v0/consent-templates/published', () => {
  it('gives a signed-in client the current version, which a grant must cite', async () => {
    const tenantId = randomUUID();
    const admin = await credential(tenantId, { admin: true, elevate: true });
    const veteran = await credential(tenantId, { admin: false, elevate: false });
    const templateKey = uniqueKey();
    const read = () =>
      app.server.inject({
        method: 'GET',
        url: `/api/v0/consent-templates/published?purpose=${templateKey}`,
        headers: veteran.headers,
      });

    expect(
      (
        await app.server.inject({
          method: 'GET',
          url: `/api/v0/consent-templates/published?purpose=${templateKey}`,
        })
      ).statusCode,
    ).toBe(401);
    await create(admin.headers, templateKey, 'Synthetic test template, v1.');
    expect((await read()).statusCode).toBe(404);

    await publish(admin.headers, `${templateKey}@1`);
    expect((await read()).json()).toMatchObject({ version_key: `${templateKey}@1`, version: 1 });
    await create(admin.headers, templateKey, 'Synthetic test template, v2.');
    await publish(admin.headers, `${templateKey}@2`);
    expect((await read()).json()).toMatchObject({
      version_key: `${templateKey}@2`,
      body: 'Synthetic test template, v2.',
    });

    // CONSENT.md §6: a grant against the superseded version is refused.
    const grant = (version: string) =>
      app.server.inject({
        method: 'POST',
        url: '/api/v0/consents',
        headers: { ...veteran.headers, 'idempotency-key': randomUUID() },
        payload: {
          permission: 'can_receive',
          scope: 'RED',
          purpose: 'Alert a trusted contact at red',
          grantee_type: 'TRUSTED_CONTACT',
          grantee_id: randomUUID(),
          consent_template_version: version,
        },
      });
    const stale = await grant(`${templateKey}@1`);
    expect(stale.statusCode).toBe(422);
    expect(stale.json().error.code).toBe('CONSENT_TEMPLATE_UNAVAILABLE');
    expect((await grant(`${templateKey}@2`)).statusCode).toBe(201);
  });
});
