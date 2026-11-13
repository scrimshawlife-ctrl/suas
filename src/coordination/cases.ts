/**
 * Support Case commands.
 *
 * Spec citations:
 * - SUAS-specs CASES.md §3 (creation and deduplication), §3.1 (atomic creation
 *   invariant), §4 (transitions), §5 (atomic assignment and claim), §7
 *   (resolution and closure)
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (named actions), §3 (idempotency and
 *   stale-state protection)
 * - V1_PROJECT_PLAN.md §2.1 (any signed-in person accepts; first accept wins). Accepting
 *   is per Service Request (decided 2026-11-05), so a case has no single owner: a helper
 *   acts on a case when they hold at least one of its requests.
 * - SUAS-specs EVENT_MODEL.md §3 (`CASE_CREATED`, `CASE_ASSIGNED`,
 *   `CASE_ESCALATED`, `CASE_RESOLVED`)
 *
 * Contested commands hold a row lock on the case for the whole check-and-write,
 * so the state check and the winning write are one atomic unit (CASES.md §5.2).
 * The partial unique index on the one active case per Veteran is a second line of
 * defence, not the only one.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
import { TERMINAL_REQUEST_STATUSES } from './request-transitions.js';
import {
  resolveCaseTransition,
  StaleCaseStateError,
  type CaseCommand,
  type CaseStatus,
} from './case-transitions.js';

export interface SupportCase {
  readonly caseId: string;
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly status: CaseStatus;
  readonly prioritySignalLevel: string | undefined;
}

interface CaseRow {
  case_id: string;
  tenant_id: string;
  veteran_user_id: string;
  status: CaseStatus;
  priority_signal_level: string | null;
}

const CASE_COLUMNS = 'case_id, tenant_id, veteran_user_id, status, priority_signal_level';

function toCase(row: CaseRow): SupportCase {
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    status: row.status,
    prioritySignalLevel: row.priority_signal_level ?? undefined,
  };
}

export class CaseNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  readonly httpStatus = 404;

  constructor() {
    super('Resource not found.');
    this.name = 'CaseNotFoundError';
  }
}

export class BlockingWorkError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(count: number) {
    super(
      `This case cannot be resolved while ${count} non-terminal Service Request(s) remain ` +
        `(SUAS-specs CASES.md §4, §7).`,
    );
    this.name = 'BlockingWorkError';
  }
}

export async function findCase(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<SupportCase | undefined> {
  const result = await db.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM support_cases WHERE tenant_id = $1 AND case_id = $2`,
    [tenantId, caseId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toCase(row);
}

/**
 * The Veteran's current case: the one new requests join and signals update. RESOLVED and
 * CLOSED cases are excluded, so a Veteran whose case is resolved has no current case until
 * they ask again (decided 2026-11-05; departs from the CASES.md §3 one-non-closed default).
 * Every reader that means "the case in play" uses this; none means "any non-closed case".
 */
export async function findCurrentCase(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<SupportCase | undefined> {
  const result = await db.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM support_cases
     WHERE tenant_id = $1 AND veteran_user_id = $2 AND status NOT IN ('RESOLVED', 'CLOSED')`,
    [tenantId, veteranUserId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toCase(row);
}

/** Queue-filter write for APPLY_EFFECTIVE_SIGNAL. Does not change case status. */
export async function setCasePrioritySignalLevel(
  tx: PoolClient,
  tenantId: string,
  caseId: string,
  level: 'RED',
): Promise<SupportCase> {
  const result = await tx.query<CaseRow>(
    `UPDATE support_cases
        SET priority_signal_level = $3, updated_at = now()
      WHERE tenant_id = $1 AND case_id = $2
      RETURNING ${CASE_COLUMNS}`,
    [tenantId, caseId, level],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CaseNotFoundError();
  return toCase(row);
}

/**
 * The requests that give standing on a case: those of its current cycle, while the case is
 * not CLOSED. Closing ends the cycle, so a former holder loses every case-level action and
 * read. `closed_at` is written only when a case becomes CLOSED and never cleared, so after an
 * admin reopen the requests created before it belong to the previous cycle and do not count.
 * Expects `$1` = tenant and `$2` = case; aliases `r` (service_requests), `c` (support_cases).
 */
const CURRENT_CYCLE_REQUESTS = `
  FROM service_requests r
  JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
 WHERE r.tenant_id = $1 AND r.case_id = $2
   AND c.status <> 'CLOSED'
   AND (c.closed_at IS NULL OR r.created_at > c.closed_at)`;

/**
 * Whether a person holds at least one Service Request of the case's current cycle: they
 * accepted it. This is the test for every case-level action (contact log, follow-ups, case
 * commands, resolve). It counts a request in any status, because a case cannot be resolved
 * until its requests are finished and the helper who ran them still has to be able to do it.
 */
export async function holdsRequestInCase(
  db: Queryable,
  tenantId: string,
  caseId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 ${CURRENT_CYCLE_REQUESTS} AND r.accepted_by_user_id = $3 LIMIT 1`,
    [tenantId, caseId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Whether this person accepted this Service Request and that request is still in the
 * case's current cycle. Closing the case, or reopening it, ends that standing: a
 * previous-cycle accept does not keep the request, its commands, or its chat.
 */
export async function requestHeldInCurrentCycle(
  db: Queryable,
  tenantId: string,
  serviceRequestId: string,
  userId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
       FROM service_requests r
       JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
      WHERE r.tenant_id = $1 AND r.service_request_id = $2
        AND r.accepted_by_user_id = $3
        AND c.status <> 'CLOSED'
        AND (c.closed_at IS NULL OR r.created_at > c.closed_at)
      LIMIT 1`,
    [tenantId, serviceRequestId, userId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Whether anyone has accepted a Service Request of the case's current cycle. */
export async function caseHasAcceptedRequest(
  db: Queryable,
  tenantId: string,
  caseId: string,
): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 ${CURRENT_CYCLE_REQUESTS} AND r.accepted_by_user_id IS NOT NULL LIMIT 1`,
    [tenantId, caseId],
  );
  return (result.rowCount ?? 0) > 0;
}

export interface OpenCaseInput {
  readonly tenantId: string;
  readonly veteranUserId: string;
  readonly prioritySignalLevel?: 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED';
  readonly actorType: 'VETERAN' | 'USER' | 'SYSTEM';
  readonly actorId: string;
  readonly correlationId?: string;
}

export interface OpenCaseResult {
  readonly supportCase: SupportCase;
  /** False when an existing non-closed case was returned instead. */
  readonly created: boolean;
}

/**
 * Open the Veteran's current Support Case, or return the one they already have.
 * A RESOLVED or CLOSED case is never reused: the Veteran's next request opens a new case.
 *
 * CASES.md §3.1: signal, event, and job delivery may be duplicated or
 * concurrent, so creation must not rely on "read no case → insert". The insert
 * races against a partial unique index; a loser resolves to the existing case
 * rather than creating a duplicate, and only the winner emits `CASE_CREATED`.
 */
export async function openCase(tx: PoolClient, input: OpenCaseInput): Promise<OpenCaseResult> {
  const caseId = randomUUID();

  const inserted = await tx.query<CaseRow>(
    `INSERT INTO support_cases (case_id, tenant_id, veteran_user_id, priority_signal_level)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING ${CASE_COLUMNS}`,
    [caseId, input.tenantId, input.veteranUserId, input.prioritySignalLevel ?? null],
  );

  const row = inserted.rows[0];
  if (row === undefined) {
    const existing = await tx.query<CaseRow>(
      `SELECT ${CASE_COLUMNS} FROM support_cases
       WHERE tenant_id = $1 AND veteran_user_id = $2 AND status NOT IN ('RESOLVED', 'CLOSED')`,
      [input.tenantId, input.veteranUserId],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(
        'Case creation conflicted but no existing non-closed case was found; ' +
          'this indicates a corrupted one-active-case index.',
      );
    }
    return { supportCase: toCase(existingRow), created: false };
  }

  await appendDomainEvent(tx, {
    eventType: 'CASE_CREATED',
    aggregateType: 'SupportCase',
    aggregateId: row.case_id,
    tenantId: input.tenantId,
    actorType: input.actorType,
    actorId: input.actorId,
    payload: { veteran_user_id: input.veteranUserId },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  return { supportCase: toCase(row), created: true };
}

/** Lock the case row for a contested command, and confirm the expected state. */
export async function lockCase(
  tx: PoolClient,
  tenantId: string,
  caseId: string,
  expectedStatus?: CaseStatus,
): Promise<SupportCase> {
  const result = await tx.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM support_cases
     WHERE tenant_id = $1 AND case_id = $2
     FOR UPDATE`,
    [tenantId, caseId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CaseNotFoundError();

  const supportCase = toCase(row);
  // RESPONDER_WORKFLOWS.md §3.1: a list may be stale; the mutation-time check
  // is authoritative.
  if (expectedStatus !== undefined && supportCase.status !== expectedStatus) {
    throw new StaleCaseStateError(expectedStatus, supportCase.status);
  }
  return supportCase;
}

/**
 * What an accept does to the case. An `OPEN` or `TRIAGED` case becomes `ASSIGNED`
 * (`CLAIM_CASE`, RESPONDER_WORKFLOWS.md §2; CASES.md §4) and emits `CASE_ASSIGNED`. A case
 * already past that point (another helper accepted an earlier request) stays as it is:
 * there is no edge back to `ASSIGNED`, and a second helper must not move the case.
 *
 * The caller holds the case row lock (`lockCase`) and has just written the request holder.
 */
export async function recordRequestAcceptedOnCase(
  tx: PoolClient,
  input: {
    readonly tenantId: string;
    readonly supportCase: SupportCase;
    readonly serviceRequestId: string;
    readonly acceptedByUserId: string;
    readonly correlationId?: string;
  },
): Promise<SupportCase> {
  if (input.supportCase.status !== 'OPEN' && input.supportCase.status !== 'TRIAGED') {
    return input.supportCase;
  }
  const transition = resolveCaseTransition('CLAIM_CASE', input.supportCase.status);
  const updated = await setCaseStatus(tx, input.tenantId, input.supportCase.caseId, transition.to);
  await appendDomainEvent(tx, {
    eventType: 'CASE_ASSIGNED',
    aggregateType: 'SupportCase',
    aggregateId: input.supportCase.caseId,
    tenantId: input.tenantId,
    actorType: 'USER',
    actorId: input.acceptedByUserId,
    payload: {
      service_request_id: input.serviceRequestId,
      accepted_by_user_id: input.acceptedByUserId,
      command: 'CLAIM_CASE',
    },
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });
  return updated;
}

async function setCaseStatus(
  tx: Queryable,
  tenantId: string,
  caseId: string,
  status: CaseStatus,
): Promise<SupportCase> {
  const result = await tx.query<CaseRow>(
    `UPDATE support_cases
       SET status = $3::suas_case_status,
           updated_at = now(),
           triaged_at = CASE WHEN $3::text = 'TRIAGED' THEN now() ELSE triaged_at END,
           resolved_at = CASE WHEN $3::text = 'RESOLVED' THEN now() ELSE resolved_at END,
           closed_at = CASE WHEN $3::text = 'CLOSED' THEN now() ELSE closed_at END
     WHERE tenant_id = $1 AND case_id = $2
     RETURNING ${CASE_COLUMNS}`,
    [tenantId, caseId, status],
  );
  const row = result.rows[0];
  if (row === undefined) throw new CaseNotFoundError();
  return toCase(row);
}

export interface CaseCommandInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly command: Exclude<CaseCommand, 'CLAIM_CASE' | 'ASSIGN_CASE' | 'RESOLVE'>;
  readonly actorId: string;
  readonly actorType: 'USER' | 'SUAS_ADMIN' | 'SYSTEM';
  readonly reason?: string;
  readonly expectedStatus?: CaseStatus;
  readonly correlationId?: string;
}

/**
 * Execute a documented non-contested case transition.
 *
 * Commands that require an assigned person are refused when no request of the case has
 * been accepted, which is what stops the CASES.md §4.1 mistake: an unassigned `OPEN` or
 * `TRIAGED` case has no assigned person, so it cannot be escalated. Where the edge is
 * reserved for the assigned user, the actor must hold a request of the case.
 */
export async function executeCaseCommand(
  pool: Pool,
  input: CaseCommandInput,
): Promise<SupportCase> {
  return withTransaction(pool, (tx) => executeCaseCommandInTx(tx, input));
}

/**
 * {@link executeCaseCommand} inside the caller's transaction, so an HTTP command commits
 * together with its idempotency record (API.md §7 rules 3 and 5).
 */
export async function executeCaseCommandInTx(
  tx: PoolClient,
  input: CaseCommandInput,
): Promise<SupportCase> {
  const supportCase = await lockCase(tx, input.tenantId, input.caseId, input.expectedStatus);
  const transition = resolveCaseTransition(input.command, supportCase.status, {
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });

  if (transition.requiresActiveAssignment) {
    if (!(await caseHasAcceptedRequest(tx, input.tenantId, input.caseId))) {
      throw new NoActiveAssignmentError(input.command);
    }
    if (
      transition.actors.includes('ASSIGNED_USER') &&
      input.actorType === 'USER' &&
      !(await holdsRequestInCase(tx, input.tenantId, input.caseId, input.actorId))
    ) {
      throw new NotAssignedError();
    }
  }

  let updated: SupportCase;
  try {
    updated = await setCaseStatus(tx, input.tenantId, input.caseId, transition.to);
  } catch (error) {
    // The Veteran already has a newer current case: the one-current-case index refuses a second.
    if (input.command === 'REOPEN' && isUniqueViolation(error)) throw new ReopenBlockedError();
    throw error;
  }

  if (input.command === 'ESCALATE') {
    await appendDomainEvent(tx, {
      eventType: 'CASE_ESCALATED',
      aggregateType: 'SupportCase',
      aggregateId: input.caseId,
      tenantId: input.tenantId,
      actorType: input.actorType,
      actorId: input.actorId,
      payload: { reason: input.reason ?? '', from_status: supportCase.status },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });
  }

  return updated;
}

/** REOPEN would give the Veteran two current cases. Nothing is merged; the admin decides. */
export class ReopenBlockedError extends Error {
  readonly code = 'ILLEGAL_TRANSITION';
  readonly httpStatus = 409;

  constructor() {
    super('This case cannot be reopened while the Veteran has another current case.');
    this.name = 'ReopenBlockedError';
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
  );
}

export class NoActiveAssignmentError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(command: string) {
    super(
      `"${command}" requires an accepted request on the case. A case nobody has accepted has ` +
        `no accepter to perform it (SUAS-specs CASES.md §4.1; RESPONDER_WORKFLOWS.md §8).`,
    );
    this.name = 'NoActiveAssignmentError';
  }
}

export class NotAssignedError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('This action is reserved for a person who accepted a request on this case.');
    this.name = 'NotAssignedError';
  }
}

/**
 * Whether a person currently holds a live request of a veteran's current case cycle.
 *
 * This is the verifier CONSENT.md §3.6 needs: the accepter's least-privilege access is a
 * documented basis, and Slice 4 denies it until something can confirm the acceptance. This
 * is that something. The request must not be terminal, so a helper whose request was
 * cancelled, expired or closed loses the basis, and a closed case grants nothing.
 */
export function createAssignmentVerifier(pool: Pool) {
  return async (params: {
    tenantId: string;
    acceptedByUserId: string;
    veteranUserId: string;
  }): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1
       FROM service_requests r
       JOIN support_cases c ON c.case_id = r.case_id AND c.tenant_id = r.tenant_id
       WHERE r.tenant_id = $1
         AND r.accepted_by_user_id = $2
         AND c.veteran_user_id = $3
         AND c.status <> 'CLOSED'
         AND (c.closed_at IS NULL OR r.created_at > c.closed_at)
         AND r.status <> ALL($4::suas_service_request_status[])
       LIMIT 1`,
      [params.tenantId, params.acceptedByUserId, params.veteranUserId, TERMINAL_REQUEST_STATUSES],
    );
    return (result.rowCount ?? 0) > 0;
  };
}
