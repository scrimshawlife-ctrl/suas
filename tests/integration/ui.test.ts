/**
 * Served-surface evidence (requires PostgreSQL).
 *
 * SUAS-specs MVP_REFERENCE.md §5 (required surfaces exist), §6 (unreleased
 * categories are not served as operational), §7.5 + ADMIN.md §2 (admin scope),
 * §8 (resource data comes from the catalog, not hard-coded truth);
 * SUAS-specs API.md §4 (session required; tenant is server-derived).
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type StartedApp } from '../../src/app.js';
import { createSession, type RecordingChallengeDelivery } from '../../src/auth/index.js';
import { createMembership, createOrganization, createUser } from '../../src/identity/index.js';
import { createResource, setResourceActive, verifyResource } from '../../src/fulfillment/index.js';
import {
  claimCase,
  createServiceRequest,
  openCase,
  recordContact,
} from '../../src/coordination/index.js';
import { withTransaction } from '../../src/db/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { auditAccessibility, DUTY_UNAVAILABLE_REASON } from '../../src/ui/index.js';
import { TEST_SESSION_SECRET, validEnv } from '../helpers/env.js';

let app: StartedApp;

beforeAll(async () => {
  app = await startApp({ env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply' }), listen: false });
});

afterAll(async () => {
  await app.close();
});

function pool() {
  const value = app.pool;
  if (value === undefined) throw new Error('The test app has no database pool.');
  return value;
}

/** Enrol a user and return a live session credential plus their tenant. */
async function signIn(
  target: StartedApp = app,
): Promise<{ credential: string; tenantId: string; userId: string }> {
  const targetPool = target.pool;
  if (targetPool === undefined) throw new Error('The test app has no database pool.');

  const tenantId = randomUUID();
  const email = syntheticEmail(`veteran-${randomUUID().slice(0, 8)}`);
  const user = await createUser(targetPool, { tenantId, email, status: 'ACTIVE' });

  const issued = await target.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges',
    payload: { tenant_id: tenantId, destination: email, method: 'EMAIL_OTP' },
  });
  expect(issued.statusCode).toBe(202);

  const delivery = target.challengeDelivery as RecordingChallengeDelivery;
  const code = delivery.lastFor(email.toLowerCase())?.secret ?? '';
  const verified = await target.server.inject({
    method: 'POST',
    url: '/api/v0/auth/challenges/commands/verify',
    payload: { tenant_id: tenantId, destination: email, code },
  });
  expect(verified.statusCode).toBe(201);

  return {
    credential: verified.json().session_credential as string,
    tenantId,
    userId: user.userId,
  };
}

function authorized(credential: string) {
  return { authorization: `Bearer ${credential}` };
}

describe('MVP_REFERENCE.md §5 — public surfaces', () => {
  it('serves the landing action surface without a session', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    for (const action of ['TAKE ACTION', 'I NEED SUPPORT', 'I WANT TO SERVE']) {
      expect(response.body, action).toContain(action);
    }
  });

  it('serves enrollment with the §7.1 contact requirement, not the reference promise', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app/join' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Join the Mission');
    expect(response.body).toContain('sign-in code');
    // §7.1: the prototype's "No email" copy contradicts AUTH.md.
    expect(response.body).not.toContain('No email');
  });

  it('serves accessible markup on the public path', async () => {
    const response = await app.server.inject({ method: 'GET', url: '/app' });
    expect(auditAccessibility(response.body)).toEqual([]);
  });
});

describe('API.md §4 — authenticated surfaces require a session', () => {
  it.each([
    '/app/home',
    '/app/check-ins',
    '/app/resources',
    '/app/chat',
    '/app/responder',
    '/app/admin',
  ])('refuses %s without a credential', async (url) => {
    const response = await app.server.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
  });

  it('serves the veteran home to a session holder', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Deploy QRF');
    expect(response.body).toContain('Immediate Resources');
    expect(auditAccessibility(response.body)).toEqual([]);
  });

  it('serves the veteran home while a QRF request is in flight', async () => {
    const { credential, tenantId, userId } = await signIn();

    // The live 500: the in-flight home drops the Deploy QRF action, which the
    // §5 required-element list demanded unconditionally.
    await withTransaction(pool(), async (tx) => {
      const opened = await openCase(tx, {
        tenantId,
        veteranUserId: userId,
        actorType: 'VETERAN',
        actorId: userId,
      });
      await createServiceRequest(tx, {
        tenantId,
        caseId: opened.supportCase.caseId,
        category: 'PEER_SUPPORT',
        createdBy: userId,
        actorType: 'VETERAN',
      });
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Your QRF request');
    expect(response.body).not.toContain('Deploy QRF');
    // §7.2: a newly recorded request claims nothing beyond being recorded.
    expect(response.body).toContain('REQUESTED');
    expect(response.body).not.toContain('RESPONDER NOTIFIED');
    expect(auditAccessibility(response.body)).toEqual([]);
  });

  it('reserves the immediate-resource slot without shipping crisis copy', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/immediate-resources',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Immediate Resources');
    expect(response.body).toContain('not available in this build');
    expect(response.body).not.toMatch(/\b988\b/);
  });

  it('renders the D-012 911/988 copy when SUAS_SAFETY_COPY_MODE=approved', async () => {
    const approved = await startApp({
      env: validEnv({ SUAS_MIGRATIONS_MODE: 'apply', SUAS_SAFETY_COPY_MODE: 'approved' }),
      listen: false,
    });
    try {
      const { credential } = await signIn(approved);
      const response = await approved.server.inject({
        method: 'GET',
        url: '/app/immediate-resources',
        headers: authorized(credential),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Need help right now?');
      expect(response.body).toContain('not an emergency service');
      expect(response.body).toContain('href="tel:911"');
      expect(response.body).toContain('href="tel:988"');
      expect(response.body).toContain('Call 911');
      expect(response.body).toContain('Call or text 988');
      expect(auditAccessibility(response.body)).toEqual([]);
    } finally {
      await approved.close();
    }
  });
});

describe('API.md §5 — /app/resources/:label queue cursor', () => {
  async function activateFood(tenantId: string, serviceName: string): Promise<string> {
    const resource = await createResource(pool(), {
      tenantId,
      serviceName,
      category: 'FOOD',
      counties: ['Example County'],
      integrationModes: ['MANUAL_COORDINATION'],
      contactMethod: 'Walk in during posted hours',
    });
    const actorId = randomUUID();
    await verifyResource(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      verificationSource: 'Called the listed number during posted hours',
      actorId,
    });
    await setResourceActive(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      active: true,
      actorId,
    });
    return resource.resourceId;
  }

  it('walks every food listing across HTML pages', async () => {
    const { credential, tenantId } = await signIn();
    const names = Array.from({ length: 5 }, (_, index) => `HTML Pantry ${index}`);
    for (const serviceName of names) {
      await activateFood(tenantId, serviceName);
    }

    const seen: string[] = [];
    let url = '/app/resources/food?limit=2';
    let pages = 0;
    for (;;) {
      const response = await app.server.inject({
        method: 'GET',
        url,
        headers: authorized(credential),
      });
      expect(response.statusCode).toBe(200);
      for (const serviceName of names) {
        if (response.body.includes(serviceName) && !seen.includes(serviceName)) {
          seen.push(serviceName);
        }
      }
      pages += 1;
      const match = response.body.match(/cursor=([^"&]+)/);
      if (match === null) break;
      if (pages > 10) throw new Error('HTML resource cursor did not terminate');
      url = `/app/resources/food?limit=2&cursor=${match[1]}`;
    }

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...names].sort());
  });

  it('rejects a malformed catalog cursor and an oversized limit', async () => {
    const { credential } = await signIn();
    const badCursor = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food?cursor=not-a-cursor',
      headers: authorized(credential),
    });
    expect(badCursor.statusCode).toBe(400);

    const oversized = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food?limit=101',
      headers: authorized(credential),
    });
    expect(oversized.statusCode).toBe(400);
  });
});

describe('MVP_REFERENCE.md §8 — resource screens read the catalog', () => {
  it('renders a configured resource with its recorded contact method', async () => {
    const { credential, tenantId } = await signIn();
    const resource = await createResource(pool(), {
      tenantId,
      serviceName: 'Example County Food Pantry',
      category: 'FOOD',
      counties: ['Example County'],
      integrationModes: ['MANUAL_COORDINATION'],
      contactMethod: 'Walk in during posted hours',
    });

    // RESOURCES.md §7: a Resource is inactive until it carries verification
    // evidence, so the veteran-facing list shows nothing until it is verified.
    const actorId = randomUUID();
    await verifyResource(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      verificationSource: 'Called the listed number during posted hours',
      actorId,
    });
    await setResourceActive(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      active: true,
      actorId,
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Example County Food Pantry');
    expect(response.body).toContain('Walk in during posted hours');
    // §8: the catalog is the source, so no scheme is guessed for the veteran.
    expect(response.body).not.toContain('tel:');
  });

  it('offers a direct tel: action when the catalog records a PHONE scheme (P-13)', async () => {
    const { credential, tenantId } = await signIn();
    const resource = await createResource(pool(), {
      tenantId,
      serviceName: 'Example County Food Pantry',
      category: 'FOOD',
      counties: ['Example County'],
      integrationModes: ['MANUAL_COORDINATION'],
      contactMethod: '+1-555-555-0101',
      contactMethodKind: 'PHONE',
    });
    const actorId = randomUUID();
    await verifyResource(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      verificationSource: 'Called the listed number during posted hours',
      actorId,
    });
    await setResourceActive(pool(), {
      tenantId,
      resourceId: resource.resourceId,
      active: true,
      actorId,
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    // §8 / P-13: the recorded scheme becomes a real action for the veteran.
    expect(response.body).toContain('href="tel:+1-555-555-0101"');
  });

  it('never shows an unverified resource to a veteran', async () => {
    const { credential, tenantId } = await signIn();
    await createResource(pool(), {
      tenantId,
      serviceName: 'Example Unverified Pantry',
      category: 'FOOD',
      integrationModes: ['MANUAL_COORDINATION'],
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/food',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('Example Unverified Pantry');
  });

  it('shows a truthful empty state for a category with no listings', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/transportation',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('No verified resources are configured');
  });

  it('serves an unreleased category as information only, never as a catalog', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/job-training',
      headers: authorized(credential),
    });

    // §6: visible for continuity, and carrying no operational listings.
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Job Training');
    expect(response.body).toContain('No verified resources are configured');
  });

  it('refuses a category that is not on the reference surface at all', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/resources/benefits',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CATEGORY_NOT_OPERATIONAL');
  });
});

describe('Every link a surface renders resolves to a registered route', () => {
  /** Internal GET targets found in rendered markup, minus in-page anchors. */
  function internalLinks(markup: string): string[] {
    return [...markup.matchAll(/<a\b[^>]*\shref="(\/[^"#?]*)"/g)]
      .map((match) => match[1] ?? '')
      .filter((href) => href !== '');
  }

  it('serves every link on the veteran home and the category surface', async () => {
    const { credential } = await signIn();

    const pages = ['/app/home', '/app/resources'];
    const seen = new Set<string>();
    for (const page of pages) {
      const rendered = await app.server.inject({
        method: 'GET',
        url: page,
        headers: authorized(credential),
      });
      expect(rendered.statusCode, page).toBe(200);
      for (const href of internalLinks(rendered.body)) seen.add(href);
    }

    // The unreleased-category cards pointed at an unregistered /info path, so
    // Counseling, Activities, and Job Training were dead links from the home.
    expect(seen.size).toBeGreaterThan(0);
    for (const href of seen) {
      const response = await app.server.inject({
        method: 'GET',
        url: href,
        headers: authorized(credential),
      });
      expect(response.statusCode, `${href} is a dead link`).not.toBe(404);
    }
  });
});

describe('MVP_REFERENCE.md §7.5 / ADMIN.md §2 — the admin overview', () => {
  it('refuses a non-admin session', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/admin',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('Chat states its own unavailability', () => {
  it('does not render an empty inbox that implies messaging works', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/chat',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Messaging is not available yet');
  });
});

describe('MVP_REFERENCE.md §9 / G-I-30 — on-duty HTML is not a stored fact', () => {
  it('keeps the On Duty landmark and states unavailability', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'GET',
      url: '/app/responder',
      headers: authorized(credential),
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('On Duty');
    expect(response.body).toContain(DUTY_UNAVAILABLE_REASON);
    expect(response.body).not.toContain('action="/app/responder/availability"');
    expect(response.body).not.toContain('Go on duty');
    expect(response.body).not.toContain('You are receiving requests.');
    expect(response.body).not.toContain('You are not receiving requests.');
    expect(auditAccessibility(response.body)).toEqual([]);
  });

  it('does not accept a duty POST — a no-op write would be a lie', async () => {
    const { credential } = await signIn();
    const response = await app.server.inject({
      method: 'POST',
      url: '/app/responder/availability',
      headers: authorized(credential),
      payload: { onDuty: 'true' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('serves GET /app/responder/availability as display-only UNAVAILABLE', async () => {
    const tenantId = randomUUID();
    const org = await createOrganization(pool(), {
      tenantId,
      name: `Org ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const responder = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`duty-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await createMembership(pool(), {
      tenantId,
      organizationId: org.organizationId,
      userId: responder.userId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    const session = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId,
      userId: responder.userId,
    });

    const response = await app.server.inject({
      method: 'GET',
      url: '/app/responder/availability',
      headers: authorized(session.credential),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('On Duty');
    expect(response.body).toContain(DUTY_UNAVAILABLE_REASON);
    expect(response.body).not.toContain('Go on duty');
    expect(auditAccessibility(response.body)).toEqual([]);
  });
});

describe('RESPONDER_WORKFLOWS.md §2 — HTML log-contact-attempt', () => {
  it('lets the assigned responder log a contact attempt from the case page', async () => {
    const tenantId = randomUUID();
    const org = await createOrganization(pool(), {
      tenantId,
      name: `Org ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const veteran = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`log-vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const responder = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`log-resp-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await createMembership(pool(), {
      tenantId,
      organizationId: org.organizationId,
      userId: responder.userId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    const opened = await withTransaction(pool(), (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: veteran.userId,
      }),
    );
    await claimCase(pool(), {
      tenantId,
      caseId: opened.supportCase.caseId,
      responderUserId: responder.userId,
      correlationId: randomUUID(),
    });
    const session = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId,
      userId: responder.userId,
    });

    const page = await app.server.inject({
      method: 'GET',
      url: `/app/responder/cases/${opened.supportCase.caseId}`,
      headers: authorized(session.credential),
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(
      `action="/app/responder/cases/${opened.supportCase.caseId}/commands/log-contact-attempt"`,
    );

    const logged = await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${opened.supportCase.caseId}/commands/log-contact-attempt`,
      headers: {
        ...authorized(session.credential),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'channel=PHONE&outcome=NO_ANSWER',
    });
    expect(logged.statusCode).toBe(303);
    expect(logged.headers.location).toBe(`/app/responder/cases/${opened.supportCase.caseId}`);

    const after = await app.server.inject({
      method: 'GET',
      url: `/app/responder/cases/${opened.supportCase.caseId}`,
      headers: authorized(session.credential),
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain('PHONE');
    expect(after.body).toContain('NO_ANSWER');
  });
});

describe('DISPATCH.md §4 — HTML create service request', () => {
  it('lets a responder create a service request from the case page', async () => {
    const tenantId = randomUUID();
    const org = await createOrganization(pool(), {
      tenantId,
      name: `Org ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const veteran = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`sr-vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const responder = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`sr-resp-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await createMembership(pool(), {
      tenantId,
      organizationId: org.organizationId,
      userId: responder.userId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    const opened = await withTransaction(pool(), (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: veteran.userId,
      }),
    );
    const session = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId,
      userId: responder.userId,
    });

    const page = await app.server.inject({
      method: 'GET',
      url: `/app/responder/cases/${opened.supportCase.caseId}`,
      headers: authorized(session.credential),
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(
      `action="/app/responder/cases/${opened.supportCase.caseId}/service-requests"`,
    );

    const created = await app.server.inject({
      method: 'POST',
      url: `/app/responder/cases/${opened.supportCase.caseId}/service-requests`,
      headers: {
        ...authorized(session.credential),
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'category=TRANSPORTATION',
    });
    expect(created.statusCode).toBe(303);
    expect(created.headers.location).toBe(`/app/responder/cases/${opened.supportCase.caseId}`);

    const after = await app.server.inject({
      method: 'GET',
      url: `/app/responder/cases/${opened.supportCase.caseId}`,
      headers: authorized(session.credential),
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toContain('TRANSPORTATION');
  });
});

describe('MVP_REFERENCE.md §9 — /app/responder/cases/:id lists contact + service requests', () => {
  it('renders bounded contact attempts and service requests without notes or details', async () => {
    const tenantId = randomUUID();
    const org = await createOrganization(pool(), {
      tenantId,
      name: `Org ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const veteran = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`case-vet-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    const responder = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`case-resp-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await createMembership(pool(), {
      tenantId,
      organizationId: org.organizationId,
      userId: responder.userId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    const opened = await withTransaction(pool(), (tx) =>
      openCase(tx, {
        tenantId,
        veteranUserId: veteran.userId,
        actorType: 'SYSTEM',
        actorId: veteran.userId,
      }),
    );
    await claimCase(pool(), {
      tenantId,
      caseId: opened.supportCase.caseId,
      responderUserId: responder.userId,
      correlationId: randomUUID(),
    });
    await recordContact(pool(), {
      tenantId,
      caseId: opened.supportCase.caseId,
      responderUserId: responder.userId,
      command: 'log-contact-attempt',
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
      note: 'secret note must not appear in HTML',
    });
    await withTransaction(pool(), (tx) =>
      createServiceRequest(tx, {
        tenantId,
        caseId: opened.supportCase.caseId,
        category: 'TRANSPORTATION',
        createdBy: responder.userId,
        actorType: 'RESPONDER',
        details: { destination: 'secret-detail-must-not-appear' },
      }),
    );
    const session = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId,
      userId: responder.userId,
    });

    const response = await app.server.inject({
      method: 'GET',
      url: `/app/responder/cases/${opened.supportCase.caseId}`,
      headers: authorized(session.credential),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Contact attempts');
    expect(response.body).toContain('PHONE');
    expect(response.body).toContain('NO_ANSWER');
    expect(response.body).toContain('Service requests');
    expect(response.body).toContain('TRANSPORTATION');
    expect(response.body).not.toContain('secret note');
    expect(response.body).not.toContain('secret-detail');
    expect(auditAccessibility(response.body)).toEqual([]);
  });
});

/**
 * HTML responder queue pagination.
 *
 * After #88 the JSON API accepts cursor/limit. These routes must accept the
 * same bounds so `/app` cannot hard-cap the queue at 20 with no page two
 * (API.md §5; MVP_REFERENCE.md §9 active-work emphasis).
 */
describe('API.md §5 — /app/responder queue cursor', () => {
  async function responderOn(tenantId: string): Promise<{ credential: string; userId: string }> {
    const org = await createOrganization(pool(), {
      tenantId,
      name: `Org ${randomUUID().slice(0, 8)}`,
      status: 'ACTIVE',
    });
    const responder = await createUser(pool(), {
      tenantId,
      email: syntheticEmail(`resp-${randomUUID().slice(0, 8)}`),
      status: 'ACTIVE',
    });
    await createMembership(pool(), {
      tenantId,
      organizationId: org.organizationId,
      userId: responder.userId,
      role: 'RESPONDER',
      status: 'ACTIVE',
    });
    const session = await createSession(pool(), TEST_SESSION_SECRET, {
      tenantId,
      userId: responder.userId,
    });
    return { credential: session.credential, userId: responder.userId };
  }

  /** Distinct veterans: CASES.md §3.1 allows one active case each. */
  async function openCasesFor(tenantId: string, count: number): Promise<string[]> {
    const caseIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const veteran = await createUser(pool(), {
        tenantId,
        email: syntheticEmail(`vet-html-page-${randomUUID().slice(0, 8)}`),
        status: 'ACTIVE',
      });
      const opened = await withTransaction(pool(), (tx) =>
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

  it('walks every unassigned case across HTML pages', async () => {
    const tenantId = randomUUID();
    const opened = await openCasesFor(tenantId, 5);
    const responder = await responderOn(tenantId);

    const seen: string[] = [];
    let url = '/app/responder?limit=2';
    let pages = 0;

    for (;;) {
      const response = await app.server.inject({
        method: 'GET',
        url,
        headers: authorized(responder.credential),
      });
      expect(response.statusCode).toBe(200);
      for (const caseId of opened) {
        if (response.body.includes(caseId) && !seen.includes(caseId)) {
          seen.push(caseId);
        }
      }
      pages += 1;
      const match = response.body.match(/unassigned_cursor=([^"&]+)/);
      if (match === null) break;
      if (pages > 10) throw new Error('HTML cursor did not terminate');
      url = `/app/responder?limit=2&unassigned_cursor=${match[1]}`;
    }

    expect(pages).toBe(3);
    expect([...seen].sort()).toEqual([...opened].sort());
  });

  it('rejects a malformed unassigned cursor and an oversized limit', async () => {
    const tenantId = randomUUID();
    await openCasesFor(tenantId, 1);
    const responder = await responderOn(tenantId);

    const badCursor = await app.server.inject({
      method: 'GET',
      url: '/app/responder?unassigned_cursor=not-a-cursor',
      headers: authorized(responder.credential),
    });
    expect(badCursor.statusCode).toBe(400);

    const oversized = await app.server.inject({
      method: 'GET',
      url: '/app/responder?limit=101',
      headers: authorized(responder.credential),
    });
    expect(oversized.statusCode).toBe(400);
  });
});

describe('QRF Call and Message stay hidden without an authorized path', () => {
  it('does not render Call or Message hrefs on the live home', async () => {
    const { credential, tenantId, userId } = await signIn();
    const idle = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(idle.statusCode).toBe(200);
    expect(idle.body).not.toContain('/app/qrf/call');
    expect(idle.body).not.toContain('/app/qrf/message');

    await withTransaction(pool(), async (tx) => {
      const opened = await openCase(tx, {
        tenantId,
        veteranUserId: userId,
        actorType: 'VETERAN',
        actorId: userId,
      });
      await createServiceRequest(tx, {
        tenantId,
        caseId: opened.supportCase.caseId,
        category: 'PEER_SUPPORT',
        createdBy: userId,
        actorType: 'VETERAN',
      });
    });

    const inFlight = await app.server.inject({
      method: 'GET',
      url: '/app/home',
      headers: authorized(credential),
    });
    expect(inFlight.statusCode).toBe(200);
    expect(inFlight.body).toContain('Your QRF request');
    expect(inFlight.body).not.toContain('/app/qrf/call');
    expect(inFlight.body).not.toContain('/app/qrf/message');
  });

  it('does not serve /app/qrf/call or /app/qrf/message as product routes', async () => {
    const { credential } = await signIn();
    for (const url of ['/app/qrf/call', '/app/qrf/message']) {
      const response = await app.server.inject({
        method: 'GET',
        url,
        headers: authorized(credential),
      });
      expect(response.statusCode, url).toBe(404);
    }
  });
});
