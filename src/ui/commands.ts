/**
 * HTML command compositions for the Slice 10 surfaces.
 *
 * These are not new domain verbs. Each function calls released coordination
 * commands the JSON API already exposes:
 * - `openCase` + `createServiceRequest` (CASES.md §3, DISPATCH.md §4 / §7)
 * - `CANCEL` on a Service Request (DISPATCH.md §4 explicit cancellation set)
 *
 * Spec citations:
 * - SUAS-specs MVP_REFERENCE.md §7.2 (deploy / cancel stay mapped to Case /
 *   Request facts; no second in-flight Deploy)
 * - SUAS-specs CASES.md §3.1 (one active Case; concurrent open is a resolve)
 * - SUAS-specs DISPATCH.md §4 / §7 (`PEER_SUPPORT`; `CANCEL` requires a reason)
 * - SUAS-specs API.md §4 (tenant and actor are server-derived)
 */

import type { Pool, PoolClient } from 'pg';
import {
  createServiceRequest,
  executeServiceRequestCommand,
  IllegalRequestTransitionError,
  openCase,
} from '../coordination/index.js';
import { withTransaction } from '../db/index.js';
import { readActiveQrf } from './read.js';

/** DISPATCH.md §4: `CANCEL` requires a reason. The veteran submitted Cancel. */
export const VETERAN_QRF_CANCEL_REASON = 'Cancelled by veteran from the QRF request surface.';

export interface DeployQrfInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly correlationId: string;
}

export interface DeployQrfResult {
  readonly serviceRequestId: string;
  /** False when an in-flight peer-support request already existed. */
  readonly created: boolean;
}

/**
 * Record a peer-support Service Request for the signed-in veteran.
 *
 * Concurrent deploys serialize on the Case row. A second Deploy while a
 * request is still in flight returns the existing request and writes nothing.
 */
export async function deployQrf(pool: Pool, input: DeployQrfInput): Promise<DeployQrfResult> {
  return withTransaction(pool, (tx) => deployQrfInTx(tx, input));
}

export async function deployQrfInTx(
  tx: PoolClient,
  input: DeployQrfInput,
): Promise<DeployQrfResult> {
  const opened = await openCase(tx, {
    tenantId: input.tenantId,
    veteranUserId: input.veteranUserId,
    actorType: 'VETERAN',
    actorId: input.veteranUserId,
    correlationId: input.correlationId,
  });

  // Hold the Case so two concurrent deploys cannot each insert a request.
  await tx.query(
    `SELECT case_id FROM support_cases WHERE tenant_id = $1 AND case_id = $2 FOR UPDATE`,
    [input.tenantId, opened.supportCase.caseId],
  );

  const existing = await readActiveQrf(tx, input.tenantId, input.veteranUserId);
  if (existing !== undefined) {
    return { serviceRequestId: existing.serviceRequestId, created: false };
  }

  const created = await createServiceRequest(tx, {
    tenantId: input.tenantId,
    caseId: opened.supportCase.caseId,
    category: 'PEER_SUPPORT',
    createdBy: input.veteranUserId,
    actorType: 'VETERAN',
    correlationId: input.correlationId,
  });

  return { serviceRequestId: created.serviceRequestId, created: true };
}

export interface CancelQrfInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly correlationId: string;
}

export interface CancelQrfResult {
  readonly serviceRequestId: string | undefined;
  /** False when there was no in-flight request (replay or already cancelled). */
  readonly cancelled: boolean;
}

/**
 * Cancel the veteran's in-flight peer-support request, if one exists.
 *
 * The handler looks up the request from tenant + veteran. It does not trust a
 * client-supplied Service Request id. A replay after cancel is a no-op.
 */
export async function cancelQrf(pool: Pool, input: CancelQrfInput): Promise<CancelQrfResult> {
  const active = await readActiveQrf(pool, input.tenantId, input.veteranUserId);
  if (active === undefined) {
    return { serviceRequestId: undefined, cancelled: false };
  }

  try {
    await executeServiceRequestCommand(pool, {
      tenantId: input.tenantId,
      serviceRequestId: active.serviceRequestId,
      command: 'CANCEL',
      actorId: input.veteranUserId,
      actorType: 'VETERAN',
      reason: VETERAN_QRF_CANCEL_REASON,
      correlationId: input.correlationId,
    });
  } catch (error) {
    // A concurrent cancel already moved the request to a terminal status.
    if (error instanceof IllegalRequestTransitionError) {
      return { serviceRequestId: active.serviceRequestId, cancelled: false };
    }
    throw error;
  }

  return { serviceRequestId: active.serviceRequestId, cancelled: true };
}
