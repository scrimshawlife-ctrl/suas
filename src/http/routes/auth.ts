/**
 * Authentication routes.
 */

import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../db/index.js';
import { appendAuditEvent } from '../../events/index.js';
import {
  elevateSession,
  issueChallenge,
  revokeAllUserSessions,
  revokeSession,
  verifyAndCreateSession,
  type ChallengeDeliveryPort,
  type MfaPort,
} from '../../auth/index.js';
import { CHALLENGE_METHODS } from '../../auth/index.js';
import { findUsersByDestination, selectUserForSignIn } from '../../identity/index.js';
import { API_PREFIX } from '../../release/pins.js';
import { authenticate } from '../authenticate.js';
import { UnauthenticatedError } from '../../authz/index.js';
import type { FixedOtpCodeFor } from '../../auth/demo-fixed-code.js';
import type { StagingAccess } from '../../auth/staging-access.js';

export interface AuthRouteDeps {
  readonly pool: Pool;
  readonly sessionSecret: string | undefined;
  readonly delivery: ChallengeDeliveryPort;
  readonly mfa: MfaPort;
  /** LOCAL demo only; see src/auth/demo-fixed-code.ts. */
  readonly fixedOtpCodeFor?: FixedOtpCodeFor | undefined;
  /**
   * Tenant that new email addresses sign up into. Taken from deployment config, never
   * from the request (API.md §4). Absent means self sign-up is off.
   */
  readonly signUpTenantId?: string | undefined;
  readonly stagingAccess?: StagingAccess | undefined;
}

const UNKNOWN_TENANT = '00000000-0000-4000-8000-000000000000';

const issueBody = z.object({
  tenant_id: z.string().uuid().optional(),
  destination: z.string().min(3).max(320),
  method: z.enum([CHALLENGE_METHODS[0], ...CHALLENGE_METHODS.slice(1)] as [string, ...string[]]),
});

const verifyBody = z.object({
  tenant_id: z.string().uuid().optional(),
  destination: z.string().min(3).max(320),
  code: z.string().min(1).max(512),
});

const mfaVerifyBody = z.object({
  challenge_id: z.string().min(1).max(128),
  response: z.string().min(1).max(512),
});

/**
 * Which tenant a sign-in request is for, and whether an unknown address may sign up
 * there. Sign-up needs the configured tenant, and no enrolled person elsewhere with
 * this address and no tenant asserted (that case stays ambiguous and sends nothing).
 */
async function tenantForSignIn(
  pool: Pool,
  destination: string,
  assertedTenantId: string | undefined,
  signUpTenantId: string | undefined,
): Promise<{ tenantId: string; allowSignUp: boolean }> {
  const matches = await findUsersByDestination(pool, destination);
  const user = selectUserForSignIn(matches, assertedTenantId);
  if (user !== undefined) return { tenantId: user.tenantId, allowSignUp: false };
  const mayJoin =
    signUpTenantId !== undefined &&
    (assertedTenantId === undefined || assertedTenantId === signUpTenantId) &&
    !matches.some((match) => match.tenantId !== signUpTenantId && assertedTenantId === undefined);
  if (mayJoin) return { tenantId: signUpTenantId, allowSignUp: true };
  return { tenantId: assertedTenantId ?? UNKNOWN_TENANT, allowSignUp: false };
}

export function registerAuthRoutes(app: FastifyInstance, deps: AuthRouteDeps): void {
  app.post(`${API_PREFIX}/auth/challenges`, async (request, reply) => {
    const body = issueBody.parse(request.body);
    const { tenantId, allowSignUp } = await tenantForSignIn(
      deps.pool,
      body.destination,
      body.tenant_id,
      deps.signUpTenantId,
    );

    await issueChallenge(
      {
        pool: deps.pool,
        sessionSecret: deps.sessionSecret,
        delivery: deps.delivery,
        fixedOtpCodeFor: deps.fixedOtpCodeFor,
        stagingAccess: deps.stagingAccess,
      },
      {
        tenantId,
        destination: body.destination,
        method: body.method as (typeof CHALLENGE_METHODS)[number],
        allowSignUp,
        correlationId: String(request.id),
      },
    );

    return reply.status(202).send({ status: 'accepted' });
  });

  app.post(`${API_PREFIX}/auth/challenges/commands/verify`, async (request, reply) => {
    const body = verifyBody.parse(request.body);
    const { tenantId } = await tenantForSignIn(
      deps.pool,
      body.destination,
      body.tenant_id,
      deps.signUpTenantId,
    );

    const issued = await verifyAndCreateSession(
      {
        pool: deps.pool,
        sessionSecret: deps.sessionSecret,
        delivery: deps.delivery,
        fixedOtpCodeFor: deps.fixedOtpCodeFor,
        stagingAccess: deps.stagingAccess,
      },
      {
        tenantId,
        destination: body.destination,
        code: body.code,
        correlationId: String(request.id),
      },
    );

    return reply.status(201).send({
      session_credential: issued.credential,
      expires_at: issued.session.expiresAt.toISOString(),
      mfa_elevated: false,
    });
  });

  app.post(`${API_PREFIX}/auth/mfa/challenges`, async (request) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const challenge = await deps.mfa.begin({
      userId: context.userId,
      sessionId: context.session.sessionId,
    });
    return { challenge_id: challenge.challengeId, factor_type: challenge.factorType };
  });

  app.post(`${API_PREFIX}/auth/mfa/challenges/commands/verify`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const body = mfaVerifyBody.parse(request.body);

    const verified = await deps.mfa.verify(body.challenge_id, body.response, {
      userId: context.userId,
      sessionId: context.session.sessionId,
    });
    if (!verified) {
      await withTransaction(deps.pool, (tx) =>
        appendAuditEvent(tx, {
          eventType: 'AUTH_MFA_FAILED',
          action: 'VERIFY_MFA',
          targetType: 'Session',
          targetId: context.session.sessionId,
          aggregateType: 'User',
          aggregateId: context.userId,
          tenantId: context.tenantId,
          actorType: 'SYSTEM',
          actorId: context.userId,
          payload: { outcome: 'FAILURE' },
          correlationId: String(request.id),
        }),
      );
      throw new UnauthenticatedError('The MFA response is not valid.');
    }

    await withTransaction(deps.pool, async (tx) => {
      await elevateSession(tx, context.session.sessionId);
      await appendAuditEvent(tx, {
        eventType: 'AUTH_PRIVILEGE_ELEVATED',
        action: 'ELEVATE_SESSION',
        targetType: 'Session',
        targetId: context.session.sessionId,
        aggregateType: 'User',
        aggregateId: context.userId,
        tenantId: context.tenantId,
        actorType: 'SYSTEM',
        actorId: context.userId,
        payload: { outcome: 'SUCCESS', factor_type: deps.mfa.factorType },
        correlationId: String(request.id),
      });
    });

    return reply.status(200).send({ mfa_elevated: true });
  });

  app.post(`${API_PREFIX}/auth/sessions/commands/logout`, async (request, reply) => {
    const context = await authenticate(deps.pool, deps.sessionSecret, request);
    const everywhere = (request.body as { everywhere?: unknown } | undefined)?.everywhere === true;

    await withTransaction(deps.pool, async (tx) => {
      if (everywhere) {
        await revokeAllUserSessions(tx, context.userId, 'LOGOUT_ALL');
      } else {
        await revokeSession(tx, context.session.sessionId, 'LOGOUT');
      }
      await appendAuditEvent(tx, {
        eventType: 'AUTH_SESSION_INVALIDATED',
        action: everywhere ? 'REVOKE_ALL_SESSIONS' : 'REVOKE_SESSION',
        targetType: 'Session',
        targetId: context.session.sessionId,
        aggregateType: 'User',
        aggregateId: context.userId,
        tenantId: context.tenantId,
        actorType: 'SYSTEM',
        actorId: context.userId,
        payload: { scope: everywhere ? 'ALL' : 'CURRENT' },
        correlationId: String(request.id),
      });
    });

    return reply.status(204).send();
  });
}
