/**
 * Consent grant JSON API (requires PostgreSQL).
 *
 * SUAS-specs APIS.md §2.2; CONSENT.md §2 / §7; API.md §4.
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
