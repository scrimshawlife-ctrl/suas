import type { Pool } from 'pg';
import { withTransaction } from '../db/index.js';
import { appendAuditEvent } from '../events/index.js';
import { findUserByDestination } from '../identity/users.js';
import {
  ChallengeVerificationFailedError,
  revokeLiveChallenges,
  verifyChallenge,
} from './challenge.js';
import type { ChallengeDeliveryPort } from './delivery.js';
import type { FixedOtpCodeFor } from './demo-fixed-code.js';
import { createSession, type IssuedSession } from './session.js';
import { stagingFixturePrincipalRefused, type StagingAccess } from './staging-access.js';

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
    readonly fixedOtpCodeFor?: FixedOtpCodeFor | undefined;
    readonly stagingAccess?: StagingAccess | undefined;
  },
  input: VerifyAndCreateSessionInput,
): Promise<IssuedSession> {
  if (deps.stagingAccess !== undefined) {
    const enrolled = await findUserByDestination(deps.pool, input.tenantId, input.destination);
    if (
      stagingFixturePrincipalRefused(
        deps.stagingAccess,
        enrolled === undefined
          ? undefined
          : { tenantId: enrolled.tenantId, userId: enrolled.userId },
      )
    ) {
      throw new ChallengeVerificationFailedError();
    }
  }

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
