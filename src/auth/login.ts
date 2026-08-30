import type { Pool } from 'pg';
import { withTransaction } from '../db/index.js';
import { appendAuditEvent } from '../events/index.js';
import { revokeLiveChallenges, verifyChallenge } from './challenge.js';
import type { ChallengeDeliveryPort } from './delivery.js';
import { createSession, type IssuedSession } from './session.js';

export interface VerifyAndCreateSessionInput {
  readonly tenantId: string;
  readonly destination: string;
  readonly code: string;
  readonly correlationId?: string;
}

/** Shared session-issuance transaction for API and HTML passwordless auth. */
export async function verifyAndCreateSession(
  deps: {
    readonly pool: Pool;
    readonly sessionSecret: string | undefined;
    readonly delivery: ChallengeDeliveryPort;
  },
  input: VerifyAndCreateSessionInput,
): Promise<IssuedSession> {
  const user = await verifyChallenge(deps, {
    tenantId: input.tenantId,
    destination: input.destination,
    secret: input.code,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return withTransaction(deps.pool, async (tx) => {
    await revokeLiveChallenges(tx, user.tenantId, input.destination);
    const issued = await createSession(tx, deps.sessionSecret, {
      tenantId: user.tenantId,
      userId: user.userId,
    });
    await appendAuditEvent(tx, {
      eventType: 'AUTH_LOGIN_SUCCEEDED',
      action: 'CREATE_SESSION',
      targetType: 'Session',
      targetId: issued.session.sessionId,
      aggregateType: 'User',
      aggregateId: user.userId,
      tenantId: user.tenantId,
      actorType: 'SYSTEM',
      actorId: user.userId,
      payload: { outcome: 'SUCCESS' },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
    return issued;
  });
}
