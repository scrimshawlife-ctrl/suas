/**
 * Support Case commands.
 *
 * Spec citations:
 * - SUAS-specs CASES.md §3 (creation and deduplication), §3.1 (atomic creation
 *   invariant), §4 (transitions), §5 (atomic assignment and claim), §7
 *   (resolution and closure)
 * - SUAS-specs RESPONDER_WORKFLOWS.md §2 (named actions), §3 (idempotency and
 *   stale-state protection)
 * - V1_PROJECT_PLAN.md §2.1 (any signed-in person accepts; first accept wins)
 * - SUAS-specs EVENT_MODEL.md §3 (`CASE_CREATED`, `CASE_ASSIGNED`,
 *   `CASE_ESCALATED`, `CASE_RESOLVED`)
 * - SUAS-specs DATA_MODEL.md §14 rule 6 (one active assignment where required)
 *
 * Contested commands hold a row lock on the case for the whole check-and-write,
 * so the state check and the winning write are one atomic unit (CASES.md §5.2).
 * The partial unique indexes are a second line of defence, not the only one.
 */

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendDomainEvent } from '../events/index.js';
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

export interface CaseAssignment {
  readonly caseAssignmentId: string;
  readonly tenantId: string;
  readonly caseId: string;
  readonly acceptedByUserId: string;
  readonly status: 'ACTIVE' | 'RELEASED' | 'REASSIGNED';
}

interface CaseRow {
  case_id: string;
  tenant_id: string;
  veteran_user_id: string;
  status: CaseStatus;
  priority_signal_level: string | null;
}

interface AssignmentRow {
  case_assignment_id: string;
  tenant_id: string;
  case_id: string;
  accepted_by_user_id: string;
  status: 'ACTIVE' | 'RELEASED' | 'REASSIGNED';
}

const CASE_COLUMNS = 'case_id, tenant_id, veteran_user_id, status, priority_signal_level';
const ASSIGNMENT_COLUMNS = 'case_assignment_id, tenant_id, case_id, accepted_by_user_id, status';

function toCase(row: CaseRow): SupportCase {
  return {
    caseId: row.case_id,
    tenantId: row.tenant_id,
    veteranUserId: row.veteran_user_id,
    status: row.status,
    prioritySignalLevel: row.priority_signal_level ?? undefined,
  };
}

function toAssignment(row: AssignmentRow): CaseAssignment {
  return {
    caseAssignmentId: row.case_assignment_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    acceptedByUserId: row.accepted_by_user_id,
    status: row.status,
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

/** CASES.md §5.4: a losing contender receives a conflict with no partial effect. */
export class CaseAlreadyClaimedError extends Error {
  readonly code = 'ALREADY_CLAIMED';
  readonly httpStatus = 409;

  constructor() {
    super('This case already has an active assignment.');
    this.name = 'CaseAlreadyClaimedError';
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

/** The MVP one-active-case projection (CASES.md §3). CLOSED rows are excluded. */
export async function findNonClosedCase(
  db: Queryable,
  tenantId: string,
  veteranUserId: string,
): Promise<SupportCase | undefined> {
  const result = await db.query<CaseRow>(
    `SELECT ${CASE_COLUMNS} FROM support_cases
     WHERE tenant_id = $1 AND veteran_user_id = $2 AND status <> 'CLOSED'`,
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

export async function findActiveAssignment(
  db: Queryable,
  caseId: string,
): Promise<CaseAssignment | undefined> {
  const result = await db.query<AssignmentRow>(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM case_assignments
     WHERE case_id = $1 AND status = 'ACTIVE'`,
    [caseId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toAssignment(row);
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
 * Open a Support Case under the MVP one-active-case default.
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
       WHERE tenant_id = $1 AND veteran_user_id = $2 AND status <> 'CLOSED'`,
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
async function lockCase(
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

export interface ClaimCaseInput {
  readonly tenantId: string;
  readonly caseId: string;
  readonly acceptedByUserId: string;
  /** Status the caller believed the case was in, from a possibly stale list. */
  readonly expectedStatus?: CaseStatus;
  /**
   * Visibility check run inside the case row lock, after the replay shortcut and
   * before "someone else already holds it". A caller who may not see the case is
   * refused here, so only a caller who could see it learns that another person won.
   */
  readonly visibilityGuard?: (tx: PoolClient, supportCase: SupportCase) => Promise<void>;
  /**
   * Eligibility check run inside the case row lock, after the already-claimed check and
   * before anything is written. It throws to refuse. The accept flow uses it so
   * "may this person accept?" and "did someone else win?" are one atomic decision.
   */
  readonly guard?: (tx: PoolClient, supportCase: SupportCase) => Promise<void>;
  /**
   * Runs inside the same transaction after the assignment is written, so anything the
   * accept must also create (such as the chat thread) commits or rolls back with it.
   * Not run on a replay, which writes nothing.
   */
  readonly afterClaim?: (tx: PoolClient, result: AssignmentResult) => Promise<void>;
  readonly correlationId?: string;
}

export interface AssignmentResult {
  readonly supportCase: SupportCase;
  readonly assignment: CaseAssignment;
}

/**
 * `CLAIM_CASE`, the "accept" of V1_PROJECT_PLAN.md §2.1. RESPONDER_WORKFLOWS.md §2, §5;
 * CASES.md §5.
 *
 * The row lock serializes contenders: the first commits an assignment and moves
 * the case to `ASSIGNED`, and the second then finds the active assignment and
 * conflicts. Exactly one wins, and the loser writes nothing.
 */
export async function claimCase(pool: Pool, input: ClaimCaseInput): Promise<AssignmentResult> {
  return withTransaction(pool, async (tx) => {
    // Lock without the expected-status check: a replay carries the same
    // expectedStatus as the original claim, which the winning claim has already
    // moved past.
    const supportCase = await lockCase(tx, input.tenantId, input.caseId);

    // CASES.md §5 item 5: replay by the same logical command returns the
    // original winning result. The person who already holds the active
    // assignment gets it back, with no new write and no second CASE_ASSIGNED
    // (§5 item 6).
    const held = await findActiveAssignment(tx, input.caseId);
    if (held?.acceptedByUserId === input.acceptedByUserId) {
      return { supportCase, assignment: held };
    }

    if (input.visibilityGuard !== undefined) {
      await input.visibilityGuard(tx, supportCase);
    }

    // First accept wins: anyone else finds the case already held and conflicts.
    if (held !== undefined) {
      throw new CaseAlreadyClaimedError();
    }

    if (input.guard !== undefined) {
      await input.guard(tx, supportCase);
    }

    if (input.expectedStatus !== undefined && supportCase.status !== input.expectedStatus) {
      throw new StaleCaseStateError(input.expectedStatus, supportCase.status);
    }
    const transition = resolveCaseTransition('CLAIM_CASE', supportCase.status);

    const assignment = await insertAssignment(tx, {
      tenantId: input.tenantId,
      caseId: input.caseId,
      acceptedByUserId: input.acceptedByUserId,
      assignedBy: input.acceptedByUserId,
    });

    const updated = await setCaseStatus(tx, input.tenantId, input.caseId, transition.to);

    await appendDomainEvent(tx, {
      eventType: 'CASE_ASSIGNED',
      aggregateType: 'SupportCase',
      aggregateId: input.caseId,
      tenantId: input.tenantId,
      actorType: 'USER',
      actorId: input.acceptedByUserId,
      payload: {
        case_assignment_id: assignment.caseAssignmentId,
        accepted_by_user_id: input.acceptedByUserId,
        command: 'CLAIM_CASE',
      },
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    const result = { supportCase: updated, assignment };
    if (input.afterClaim !== undefined) {
      await input.afterClaim(tx, result);
    }
    return result;
  });
}

async function insertAssignment(
  tx: Queryable,
  input: {
    tenantId: string;
    caseId: string;
    acceptedByUserId: string;
    assignedBy: string;
  },
): Promise<CaseAssignment> {
  const result = await tx.query<AssignmentRow>(
    `INSERT INTO case_assignments
       (case_assignment_id, tenant_id, case_id, accepted_by_user_id, assigned_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${ASSIGNMENT_COLUMNS}`,
    [randomUUID(), input.tenantId, input.caseId, input.acceptedByUserId, input.assignedBy],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('Assignment insert returned no row.');
  return toAssignment(row);
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
 * Commands that require an active assignment are refused when none exists,
 * which is what stops the CASES.md §4.1 mistake: an unassigned `OPEN` or
 * `TRIAGED` case has no assigned person, so it cannot be escalated.
 */
export async function executeCaseCommand(
  pool: Pool,
  input: CaseCommandInput,
): Promise<SupportCase> {
  return withTransaction(pool, async (tx) => {
    const supportCase = await lockCase(tx, input.tenantId, input.caseId, input.expectedStatus);
    const transition = resolveCaseTransition(input.command, supportCase.status, {
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    if (transition.requiresActiveAssignment) {
      const assignment = await findActiveAssignment(tx, input.caseId);
      if (assignment === undefined) {
        throw new NoActiveAssignmentError(input.command);
      }
      if (
        transition.actors.includes('ASSIGNED_USER') &&
        input.actorType === 'USER' &&
        assignment.acceptedByUserId !== input.actorId
      ) {
        throw new NotAssignedError();
      }
    }

    // Closing ends the case cycle, so ownership ends with it. Otherwise a
    // reopened case would return to OPEN still owned by the previous accepter,
    // and could never be claimed for the new cycle — CASES.md §4 has no
    // OPEN-with-active-assignment state. The assignment row is retained as
    // history (§7: closure retains all history). The released text does not say
    // this outright; see the Slice 6 conformance record.
    if (input.command === 'CLOSE') {
      const active = await findActiveAssignment(tx, input.caseId);
      if (active !== undefined) {
        await tx.query(
          `UPDATE case_assignments
             SET status = 'RELEASED', released_at = now(), release_reason = 'CASE_CLOSED'
           WHERE case_assignment_id = $1`,
          [active.caseAssignmentId],
        );
      }
    }

    const updated = await setCaseStatus(tx, input.tenantId, input.caseId, transition.to);

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
  });
}

export class NoActiveAssignmentError extends Error {
  readonly code = 'UNPROCESSABLE';
  readonly httpStatus = 422;

  constructor(command: string) {
    super(
      `"${command}" requires an active case assignment. An unassigned case has no assigned ` +
        `accepter to perform it (SUAS-specs CASES.md §4.1; RESPONDER_WORKFLOWS.md §8).`,
    );
    this.name = 'NoActiveAssignmentError';
  }
}

export class NotAssignedError extends Error {
  readonly code = 'FORBIDDEN';
  readonly httpStatus = 403;

  constructor() {
    super('This action is reserved for the person who accepted the case.');
    this.name = 'NotAssignedError';
  }
}

/**
 * Whether a person currently holds an active assignment for a veteran's case.
 *
 * This is the verifier CONSENT.md §3.6 needs: the accepter's
 * least-privilege access is a documented basis, and Slice 4 denies it until
 * something can confirm the assignment. This is that something.
 */
export function createAssignmentVerifier(pool: Pool) {
  return async (params: {
    tenantId: string;
    acceptedByUserId: string;
    veteranUserId: string;
  }): Promise<boolean> => {
    const result = await pool.query(
      `SELECT 1
       FROM case_assignments a
       JOIN support_cases c ON c.case_id = a.case_id
       WHERE a.tenant_id = $1
         AND a.accepted_by_user_id = $2
         AND a.status = 'ACTIVE'
         AND c.veteran_user_id = $3
         AND c.status <> 'CLOSED'`,
      [params.tenantId, params.acceptedByUserId, params.veteranUserId],
    );
    return (result.rowCount ?? 0) > 0;
  };
}
