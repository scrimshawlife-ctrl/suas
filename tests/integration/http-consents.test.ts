/**
 * Consent grant JSON API (requires PostgreSQL).
 *
 * SUAS-specs APIS.md §2.2; CONSENT.md §2 / §4 / §7; API.md §4 / §7.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession } from '../../src/auth/index.js';
import {
  consentTemplateVersionKey,
  createConsentTemplateVersion,
  grantConsent,
  publishConsentTemplateVersion,
} from '../../src/consent/index.js';
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

async function publishedTemplate(pool: NonNullable<StartedApp['pool']>) {
  const templateKey = `http-consent-${randomUUID().slice(0, 8)}`;
  const versionKey = consentTemplateVersionKey(templateKey, 1);
  await createConsentTemplateVersion(pool, {
    templateKey,
    version: 1,
    body: 'Synthetic consent template for HTTP tests.',
  });
  await publishConsentTemplateVersion(pool, versionKey, undefined);
  return versionKey;
}

describe('GET /api/v0/consents', () => {
  it('requires authentication', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/api/v0/consents' });
    expect(response.statusCode).toBe(401);
  });

  it('lists only the caller veteran grants and hides other tenants', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const template = await publishedTemplate(pool);

    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const grant = await grantConsent(pool, {
      tenantId,
      veteranUserId: veteran.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'trusted contact alerts',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: randomUUID(),
      consentTemplateVersion: template,
    });

    const otherTenant = randomUUID();
    const otherVeteran = await createUser(pool, {
      tenantId: otherTenant,
      email: syntheticEmail(`other-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await grantConsent(pool, {
      tenantId: otherTenant,
      veteranUserId: otherVeteran.userId,
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'other tenant',
      granteeType: 'TRUSTED_CONTACT',
      granteeId: randomUUID(),
      consentTemplateVersion: template,
    });

    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: veteran.userId,
    });
    const response = await app.server.inject({
      method: 'GET',
      url: '/api/v0/consents',
      headers: { authorization: `Bearer ${session.credential}` },
    });
    expect(response.statusCode).toBe(200);
    const body: { consents: { consent_grant_id: string; status: string }[] } = response.json();
    expect(body.consents.map((row) => row.consent_grant_id)).toEqual([grant.consentGrantId]);
    expect(body.consents[0]).toMatchObject({
      permission: 'can_receive',
      scope: 'RED',
      status: 'ACTIVE',
      grantee_type: 'TRUSTED_CONTACT',
    });
  });
});

describe('POST /api/v0/consents', () => {
  it('requires Idempotency-Key and grants for the caller only', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const template = await publishedTemplate(pool);
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: veteran.userId,
    });
    const headers = { authorization: `Bearer ${session.credential}` };
    const payload = {
      permission: 'can_receive',
      scope: 'RED',
      purpose: 'trusted contact alerts',
      grantee_type: 'TRUSTED_CONTACT',
      grantee_id: randomUUID(),
      consent_template_version: template,
    };

    const missingKey = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers,
      payload,
    });
    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });

    const created = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers: { ...headers, 'idempotency-key': `grant-${randomUUID()}` },
      payload,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      permission: 'can_receive',
      scope: 'RED',
      status: 'ACTIVE',
      replayed: false,
    });
  });

  it('replays an identical Idempotency-Key without creating a second grant', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const template = await publishedTemplate(pool);
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: veteran.userId,
    });
    const key = `grant-replay-${randomUUID()}`;
    const headers = {
      authorization: `Bearer ${session.credential}`,
      'idempotency-key': key,
    };
    const payload = {
      permission: 'can_view',
      scope: 'support_signal',
      purpose: 'view signal',
      grantee_type: 'TRUSTED_CONTACT',
      grantee_id: randomUUID(),
      consent_template_version: template,
    };
    const first = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().consent_grant_id as string;

    const second = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers,
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      consent_grant_id: firstId,
      replayed: true,
    });

    const listed = await app.server.inject({
      method: 'GET',
      url: '/api/v0/consents',
      headers: { authorization: headers.authorization },
    });
    expect(listed.json().consents).toHaveLength(1);
  });

  it('rejects a conflicting payload for the same Idempotency-Key', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const template = await publishedTemplate(pool);
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: veteran.userId,
    });
    const key = `grant-conflict-${randomUUID()}`;
    const headers = {
      authorization: `Bearer ${session.credential}`,
      'idempotency-key': key,
    };
    const first = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers,
      payload: {
        permission: 'can_receive',
        scope: 'YELLOW',
        purpose: 'first',
        grantee_type: 'TRUSTED_CONTACT',
        grantee_id: randomUUID(),
        consent_template_version: template,
      },
    });
    expect(first.statusCode).toBe(201);
    const conflict = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers,
      payload: {
        permission: 'can_receive',
        scope: 'RED',
        purpose: 'second different',
        grantee_type: 'TRUSTED_CONTACT',
        grantee_id: randomUUID(),
        consent_template_version: template,
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT' } });
  });
});

describe('POST /api/v0/consents/:id/commands/revoke', () => {
  it('revokes an owned grant and hides foreign grants', async () => {
    const pool = app.pool;
    if (pool === undefined) throw new Error('no pool');
    const template = await publishedTemplate(pool);
    const tenantId = randomUUID();
    const veteran = await createUser(pool, {
      tenantId,
      email: syntheticEmail(`vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const session = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId,
      userId: veteran.userId,
    });
    const headers = { authorization: `Bearer ${session.credential}` };
    const created = await app.server.inject({
      method: 'POST',
      url: '/api/v0/consents',
      headers: { ...headers, 'idempotency-key': `grant-${randomUUID()}` },
      payload: {
        permission: 'can_receive',
        scope: 'ORANGE',
        purpose: 'revoke me',
        grantee_type: 'TRUSTED_CONTACT',
        grantee_id: randomUUID(),
        consent_template_version: template,
      },
    });
    expect(created.statusCode).toBe(201);
    const grantId = created.json().consent_grant_id as string;

    const revoked = await app.server.inject({
      method: 'POST',
      url: `/api/v0/consents/${grantId}/commands/revoke`,
      headers: { ...headers, 'idempotency-key': `revoke-${randomUUID()}` },
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      consent_grant_id: grantId,
      status: 'REVOKED',
      replayed: false,
    });

    const otherTenant = randomUUID();
    const other = await createUser(pool, {
      tenantId: otherTenant,
      email: syntheticEmail(`other-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const otherSession = await createSession(pool, TEST_SESSION_SECRET, {
      tenantId: otherTenant,
      userId: other.userId,
    });
    const leak = await app.server.inject({
      method: 'POST',
      url: `/api/v0/consents/${grantId}/commands/revoke`,
      headers: {
        authorization: `Bearer ${otherSession.credential}`,
        'idempotency-key': `revoke-leak-${randomUUID()}`,
      },
    });
    expect(leak.statusCode).toBe(404);
  });
});
