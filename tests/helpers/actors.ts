/**
 * Shared actors for HTTP integration tests: the app's pool, signed-in synthetic people,
 * idempotency-keyed headers and a Veteran with an open RED case. Each option below is a
 * variant some test file depends on, so callers state their variant instead of copying a helper.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { StartedApp } from '../../src/app.js';
import { createSession, elevateSession } from '../../src/auth/index.js';
import { findCurrentCase } from '../../src/coordination/index.js';
import {
  createUser,
  findUserById,
  grantSuasAdmin,
  setUserDisplayName,
  type ServiceCounty,
  type User,
} from '../../src/identity/index.js';
import { ensurePublishedQv001 } from '../../src/signals/index.js';
import { syntheticEmail } from '../../src/testing/fixture-boundary.js';
import { TEST_SESSION_SECRET } from './env.js';
import { markVerifiedVeteran } from './verified-veteran.js';

/** The started app's database pool; integration apps always have one. */
export function appPool(app: StartedApp): Pool {
  const value = app.pool;
  if (value === undefined) throw new Error('The test app has no database pool.');
  return value;
}

/** Bearer headers for a new session of an existing user; `elevate` adds MFA elevation. */
export async function bearer(
  app: StartedApp,
  tenantId: string,
  userId: string,
  elevate = false,
): Promise<{ authorization: string }> {
  const pool = appPool(app);
  const session = await createSession(pool, TEST_SESSION_SECRET, { tenantId, userId });
  if (elevate) await elevateSession(pool, session.session.sessionId);
  return { authorization: `Bearer ${session.credential}` };
}

export interface PersonOptions {
  /** Defaults to a fresh synthetic tenant. */
  readonly tenantId?: string | undefined;
  /** Prefix of the synthetic email address. */
  readonly label: string;
  /** Set at sign-up; omitted leaves the user without one. */
  readonly county?: ServiceCounty | undefined;
  /** Adds a VERIFIED VA confirmation, which also gives a county-less user Santa Clara. */
  readonly verified?: boolean | undefined;
  readonly displayName?: string | undefined;
  /** Grants SUAS System Administrator. */
  readonly admin?: boolean | undefined;
  /** MFA-elevates the session; defaults to `admin`. */
  readonly elevate?: boolean | undefined;
}

export interface Actor {
  readonly tenantId: string;
  readonly userId: string;
  readonly user: User;
  readonly sessionId: string;
  readonly headers: Record<string, string>;
}

/** An ACTIVE synthetic user with a session, shaped by `options`. */
export async function createPerson(app: StartedApp, options: PersonOptions): Promise<Actor> {
  const pool = appPool(app);
  const tenantId = options.tenantId ?? randomUUID();
  const created = await createUser(pool, {
    tenantId,
    email: syntheticEmail(`${options.label}-${randomUUID().slice(0, 8)}`),
    status: 'ACTIVE',
    ...(options.county !== undefined ? { county: options.county } : {}),
  });
  if (options.verified === true) {
    await markVerifiedVeteran(pool, tenantId, created.userId, options.county ?? 'SANTA_CLARA');
  }
  if (options.displayName !== undefined) {
    await setUserDisplayName(pool, tenantId, created.userId, options.displayName);
  }
  if (options.admin === true) await grantSuasAdmin(pool, created.userId, undefined);
  const session = await createSession(pool, TEST_SESSION_SECRET, {
    tenantId,
    userId: created.userId,
  });
  // An explicit `elevate` wins, including `false` for an unelevated admin.
  const elevate = options.elevate === undefined ? options.admin === true : options.elevate;
  if (elevate) await elevateSession(pool, session.session.sessionId);
  // Read back after setup: the verified county and display name land after sign-up.
  const user = await findUserById(pool, tenantId, created.userId);
  if (user === undefined) throw new Error('createPerson: the new user is missing.');
  return {
    tenantId,
    userId: user.userId,
    user,
    sessionId: session.session.sessionId,
    headers: { authorization: `Bearer ${session.credential}` },
  };
}

/**
 * `who`'s headers plus an idempotency key, fresh unless `key` is given. The key is set
 * last, so a stale key in `who.headers` never wins.
 */
export function keyed(
  who: { readonly headers: Record<string, string> },
  key: string = randomUUID(),
): Record<string, string> {
  return { ...who.headers, 'idempotency-key': key };
}

/** QV-001 answers that score A0 (no concern); `openRedCase` overrides `safe_now`. */
const A0: Readonly<Record<string, string>> = {
  sleep_manage_7d: 'NOT_AT_ALL',
  reliable_connection_now: 'WELL_CONNECTED',
  stress_manage_7d: 'NOT_AT_ALL',
  basic_needs_48h: 'SECURE',
  coping_24h: 'ABLE',
  safe_now: 'YES',
};

/**
 * Throws when a setup request is refused. Setup is not the behaviour under test, so a
 * refusal fails the caller with the step and the API's answer, not a test assertion.
 */
function setupStep(response: { statusCode: number; body: string }, status: number, step: string) {
  if (response.statusCode === status) return;
  throw new Error(`openRedCase: ${step} returned ${response.statusCode}: ${response.body}`);
}

interface QuestionJson {
  question_id: string;
  question_key: string;
  options: { answer_option_id: string; option_key: string }[];
}

/**
 * A verified Santa Clara Veteran completes a check-in answering `safe_now` with
 * NO_IMMEDIATE_HELP, which opens a RED Support Case through the public API.
 * Fixed on purpose: NO_IMMEDIATE_HELP is rule R-RED-01 (src/signals/sv-001.ts), and
 * callers that add staff or peers create them in Santa Clara to reach this case.
 */
export async function openRedCase(app: StartedApp) {
  const pool = appPool(app);
  const vet = await createPerson(app, { label: 'vet', county: 'SANTA_CLARA', verified: true });
  const { tenantId, user: veteran, headers } = vet;
  await ensurePublishedQv001(pool, veteran.userId);
  const started = await app.server.inject({
    method: 'POST',
    url: '/api/v0/check-ins',
    headers,
  });
  setupStep(started, 201, 'starting the check-in');
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
      headers,
      payload: {
        question_id: question.question_id,
        answer_option_id: option.answer_option_id,
      },
    });
    setupStep(saved, 200, `answering ${question.question_key}`);
  }
  const completed = await app.server.inject({
    method: 'POST',
    url: `/api/v0/check-ins/${body.check_in_id}/commands/complete`,
    headers,
  });
  setupStep(completed, 200, 'completing the check-in');
  const supportCase = await findCurrentCase(pool, tenantId, veteran.userId);
  if (supportCase === undefined) throw new Error('expected RED case');
  return { pool, tenantId, veteran, headers, supportCase };
}
