/**
 * Synthetic privacy deletion drill.
 *
 * Spec citations:
 * - SUAS-specs PRIVACY.md §2 (deletion is a documented process; events/audit
 *   are not silently destroyed; consent history is preserved)
 * - SUAS-specs PRIVACY.md §9 (deletion requests emit Audit Events)
 * - SUAS-specs PRIVACY.md §10 (D-007 `DECISION_PENDING`: soft-delete operational
 *   rows; do not purge Audit Events or Domain Events; fulfill a deletion request
 *   only to the extent a later spec allows; provider-side copies are
 *   `NOT_COMPUTABLE`)
 * - SUAS-specs SECURITY.md §2 (soft-delete plus process; events not casually
 *   purged; no sensitive data in logs)
 * - SUAS-specs AUTH.md §5 (REVOKED invalidates sessions)
 * - SUAS-specs CONSENT.md §4 (consent history survives; grant rows are not
 *   deleted)
 * - SUAS-specs ENVIRONMENT.md §2, §5 (LOCAL/TEST are synthetic-only; drills
 *   refuse PRODUCTION and real external effects)
 * - SUAS-specs TESTING.md §11 (`PRIVACY` gate), §12 (synthetic veterans only)
 * - SUAS-specs EVENT_MODEL.md §3 (Domain Event catalog is not extended here),
 *   §4 (Audit Events), §5.7 (no invented destructive event purge)
 *
 * This module rehearses the released deletion path against a synthetic database.
 * It does not invent a retention duration, a veteran-facing deletion API, a new
 * Domain Event type, provider-side erasure, HIPAA compliance, or a `READY`
 * verdict.
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { revokeAllUserSessions, resolveSession, createSession } from '../auth/index.js';
import type { SuasConfig } from '../config/index.js';
import { productionDataMarkersIn } from '../config/index.js';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent, appendDomainEvent, DOMAIN_EVENT_TYPES } from '../events/index.js';
import { recordConsentEvent } from '../consent/grants.js';
import {
  createUser,
  findUserByDestination,
  findUserById,
  softDeleteUser,
} from '../identity/users.js';
import { syntheticEmail } from '../testing/fixture-boundary.js';

/** Environments that may run this mutating synthetic drill. */
export const DELETION_DRILL_ENVIRONMENTS = ['LOCAL', 'TEST'] as const;

/**
 * Operational bound for one drill run. This is not a released RTO (D-024 is
 * `DECISION_PENDING`) and must not be read as a recovery objective.
 */
export const DELETION_DRILL_TIMEOUT_MS = 15_000;

/**
 * Per-statement bound inside the mutating transaction. Implementation mechanism
 * only; ARCHITECTURE.md §13 requires finite timeouts. Not a released SLO.
 */
export const DELETION_DRILL_STATEMENT_TIMEOUT_MS = 10_000;

/** Audit Event type for a recorded deletion request. Not a Domain Event. */
export const DELETION_REQUEST_AUDIT_EVENT_TYPE = 'DELETION_REQUEST';

/** Fixed PRIVACY verdict. The drill has no path to `READY`. */
export const PRIVACY_GATE_VERDICT = 'NOT_READY' as const;

export const D_007_RETENTION = 'DECISION_PENDING' as const;

export const PROVIDER_SIDE_COPIES = 'NOT_COMPUTABLE' as const;

export const DELETION_FULFILLMENT = 'SOFT_DELETE_OPERATIONAL_ROW' as const;

export class DeletionDrillEnvironmentError extends Error {
  readonly code = 'DELETION_DRILL_ENVIRONMENT';
  constructor(message: string) {
    super(message);
    this.name = 'DeletionDrillEnvironmentError';
  }
}

export class DeletionDrillTimeoutError extends Error {
  readonly code = 'DELETION_DRILL_TIMEOUT';
  constructor(timeoutMs: number) {
    super(
      `Deletion drill exceeded the ${timeoutMs}ms operational timeout. This bound is ` +
        'an implementation mechanism, not a released RTO (SUAS-specs DECISIONS.md D-024).',
    );
    this.name = 'DeletionDrillTimeoutError';
  }
}

export class DeletionDrillInvariantError extends Error {
  readonly code = 'DELETION_DRILL_INVARIANT';
  constructor(message: string) {
    super(message);
    this.name = 'DeletionDrillInvariantError';
  }
}

export interface DeletionDrillReport {
  readonly status: 'ok';
  readonly privacy_gate: typeof PRIVACY_GATE_VERDICT;
  readonly hipaa_claim: false;
  readonly d007: typeof D_007_RETENTION;
  readonly provider_side_copies: typeof PROVIDER_SIDE_COPIES;
  readonly fulfillment: typeof DELETION_FULFILLMENT;
  readonly subject_user_id: string;
  readonly tenant_id: string;
  readonly neighbor_user_id: string;
  readonly other_tenant_id: string;
  readonly deletion_request_audit_event_id: string;
  readonly operational_lookup_after: 'absent';
  readonly row_retained: true;
  readonly status_after: 'REVOKED';
  readonly sessions_revoked: number;
  readonly history: {
    readonly domain_events_retained: number;
    readonly audit_events_retained: number;
    readonly consent_events_retained: number;
  };
  readonly neighbor_untouched: true;
  readonly other_tenant_untouched: true;
  readonly replay: {
    readonly soft_delete: 'no_op';
    readonly sessions: 'no_op';
    readonly request_recorded_once: true;
  };
  readonly scale_note: 'single_logical_postgres';
  readonly note: string;
}

export function isDeletionRequestDomainEvent(): boolean {
  return (DOMAIN_EVENT_TYPES as readonly string[]).includes(DELETION_REQUEST_AUDIT_EVENT_TYPE);
}

/**
 * Refuse any environment that is not a local/test synthetic database.
 *
 * STAGING is synthetic-only in ENVIRONMENT.md but is a shared soak target; this
 * mutating drill stays on LOCAL/TEST so it cannot erase another run's fixtures.
 */
export function assertDeletionDrillEnvironment(config: SuasConfig): void {
  if (config.environment === 'PRODUCTION') {
    throw new DeletionDrillEnvironmentError(
      'A deletion drill cannot run against PRODUCTION. ENVIRONMENT.md §5 keeps ' +
        'drills on synthetic data, and SPEC-018 has not authorized production operation.',
    );
  }
  if (!(DELETION_DRILL_ENVIRONMENTS as readonly string[]).includes(config.environment)) {
    throw new DeletionDrillEnvironmentError(
      `A deletion drill cannot run in ${config.environment}. Only LOCAL and TEST ` +
        'synthetic databases are accepted (SUAS-specs ENVIRONMENT.md §2, §5; ' +
        'PRIVACY.md §10).',
    );
  }
  if (config.allowRealExternalEffects) {
    throw new DeletionDrillEnvironmentError(
      'A deletion drill cannot run while real external effects are enabled ' +
        '(SUAS-specs ENVIRONMENT.md §2, §5).',
    );
  }
  const databaseUrl = config.database.url;
  if (databaseUrl === undefined) {
    throw new DeletionDrillEnvironmentError(
      'DATABASE_URL is required for the deletion drill (SUAS-specs ENVIRONMENT.md §3).',
    );
  }
  const markers = productionDataMarkersIn(databaseUrl);
  if (markers.length > 0) {
    throw new DeletionDrillEnvironmentError(
      `DATABASE_URL host/database name contains production marker(s) ${markers
        .map((marker) => `"${marker}"`)
        .join(', ')}. LOCAL/TEST must not point at production data resources ` +
        '(SUAS-specs ENVIRONMENT.md §3, §5).',
    );
  }
}

const DRILL_NOTE =
  'Synthetic deletion path only: records a deletion request as an Audit Event, ' +
  'soft-deletes the operational user row, and revokes sessions. Audit Events, ' +
  'Domain Events, and consent history are retained. D-007 is DECISION_PENDING, ' +
  'so no automatic purge runs. Provider-side copies are NOT_COMPUTABLE. PRIVACY ' +
  'stays NOT_READY. This is one logical PostgreSQL system of record and does not ' +
  'prove sharded or multi-cluster deletion. No HIPAA claim.';

export function deletionDrillNote(): string {
  return DRILL_NOTE;
}

async function countRows(
  db: Queryable,
  table: 'domain_events' | 'audit_events' | 'consent_events',
  tenantId: string,
  subjectUserId: string,
): Promise<number> {
  if (table === 'domain_events') {
    const result = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM domain_events
       WHERE tenant_id = $1 AND aggregate_id = $2`,
      [tenantId, subjectUserId],
    );
    return result.rows[0]?.n ?? 0;
  }
  if (table === 'audit_events') {
    const result = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE tenant_id = $1 AND target_type = 'user' AND target_id = $2`,
      [tenantId, subjectUserId],
    );
    return result.rows[0]?.n ?? 0;
  }
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM consent_events
     WHERE tenant_id = $1 AND veteran_user_id = $2`,
    [tenantId, subjectUserId],
  );
  return result.rows[0]?.n ?? 0;
}

async function findDeletionRequestAuditId(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<string | undefined> {
  const result = await db.query<{ audit_event_id: string }>(
    `SELECT audit_event_id FROM audit_events
     WHERE tenant_id = $1
       AND event_type = $2
       AND target_type = 'user'
       AND target_id = $3
     ORDER BY occurred_at ASC, audit_event_id ASC
     LIMIT 1`,
    [tenantId, DELETION_REQUEST_AUDIT_EVENT_TYPE, userId],
  );
  return result.rows[0]?.audit_event_id;
}

/**
 * Record the deletion request if absent, soft-delete the operational row, and
 * revoke live sessions. Replay is a no-op for each step.
 */
export async function fulfillSyntheticDeletion(
  db: Queryable,
  input: {
    readonly tenantId: string;
    readonly userId: string;
    readonly actorId: string;
  },
): Promise<{
  readonly auditEventId: string;
  readonly requestDeduplicated: boolean;
  readonly softDeleted: boolean;
  readonly sessionsRevoked: number;
}> {
  const existing = await findDeletionRequestAuditId(db, input.tenantId, input.userId);
  let auditEventId = existing;
  let requestDeduplicated = existing !== undefined;
  if (auditEventId === undefined) {
    const recorded = await appendAuditEvent(db, {
      eventType: DELETION_REQUEST_AUDIT_EVENT_TYPE,
      action: 'RECORD',
      targetType: 'user',
      targetId: input.userId,
      aggregateType: 'User',
      aggregateId: input.userId,
      tenantId: input.tenantId,
      actorType: 'SYSTEM',
      actorId: input.actorId,
      payload: {
        fulfillment: DELETION_FULFILLMENT,
        d007: D_007_RETENTION,
        provider_side_copies: PROVIDER_SIDE_COPIES,
        automatic_event_purge: false,
      },
    });
    auditEventId = recorded.auditEventId;
    requestDeduplicated = false;
  }

  const softDeleted = await softDeleteUser(db, input.tenantId, input.userId);
  const sessionsRevoked = await revokeAllUserSessions(db, input.userId, 'USER_REVOKED');

  return {
    auditEventId,
    requestDeduplicated,
    softDeleted,
    sessionsRevoked,
  };
}

async function runDeletionDrillBody(pool: Pool, config: SuasConfig): Promise<DeletionDrillReport> {
  assertDeletionDrillEnvironment(config);
  if (isDeletionRequestDomainEvent()) {
    throw new DeletionDrillInvariantError(
      'DELETION_REQUEST must remain an Audit Event type; adding it to the Domain ' +
        'Event catalog requires an additive spec change (SUAS-specs EVENT_MODEL.md §3).',
    );
  }

  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const subjectEmail = syntheticEmail(`deletion-subject-${randomUUID().slice(0, 8)}`);
  const neighborEmail = syntheticEmail(`deletion-neighbor-${randomUUID().slice(0, 8)}`);
  const otherEmail = syntheticEmail(`deletion-other-${randomUUID().slice(0, 8)}`);

  const subject = await createUser(pool, {
    tenantId,
    email: subjectEmail,
    status: 'ACTIVE',
  });
  const neighbor = await createUser(pool, {
    tenantId,
    email: neighborEmail,
    status: 'ACTIVE',
  });
  const other = await createUser(pool, {
    tenantId: otherTenantId,
    email: otherEmail,
    status: 'ACTIVE',
  });

  const issued = await createSession(pool, config.sessionSecret, {
    tenantId,
    userId: subject.userId,
  });

  await appendDomainEvent(pool, {
    eventType: 'VETERAN_ENROLLED',
    aggregateType: 'User',
    aggregateId: subject.userId,
    tenantId,
    actorType: 'SYSTEM',
    actorId: 'deletion-drill',
    payload: { user_id: subject.userId },
    idempotencyKey: `deletion-drill:enrolled:${subject.userId}`,
  });

  await appendAuditEvent(pool, {
    eventType: 'SEEDED_HISTORY',
    action: 'RECORD',
    targetType: 'user',
    targetId: subject.userId,
    aggregateType: 'User',
    aggregateId: subject.userId,
    tenantId,
    actorType: 'SYSTEM',
    actorId: 'deletion-drill',
    payload: { purpose: 'deletion_drill_history' },
  });

  await recordConsentEvent(pool, {
    tenantId,
    veteranUserId: subject.userId,
    eventType: 'DENIED',
    permission: 'can_view',
    scope: 'support_signal',
    granteeType: 'TRUSTED_CONTACT',
    granteeId: 'deletion-drill-grantee',
    purpose: 'deletion_drill_history',
    payload: { purpose: 'deletion_drill_history' },
  });

  const historyBefore = {
    domain: await countRows(pool, 'domain_events', tenantId, subject.userId),
    audit: await countRows(pool, 'audit_events', tenantId, subject.userId),
    consent: await countRows(pool, 'consent_events', tenantId, subject.userId),
  };
  if (historyBefore.domain < 1 || historyBefore.audit < 1 || historyBefore.consent < 1) {
    throw new DeletionDrillInvariantError(
      'Deletion drill could not seed retained history before fulfillment.',
    );
  }

  const first = await withTransaction(pool, async (tx) => {
    await tx.query('SELECT set_config($1, $2, true)', [
      'statement_timeout',
      String(DELETION_DRILL_STATEMENT_TIMEOUT_MS),
    ]);
    return fulfillSyntheticDeletion(tx, {
      tenantId,
      userId: subject.userId,
      actorId: 'deletion-drill',
    });
  });

  if (!first.softDeleted) {
    throw new DeletionDrillInvariantError(
      'First fulfillment did not soft-delete the operational user row.',
    );
  }
  if (first.requestDeduplicated) {
    throw new DeletionDrillInvariantError(
      'First fulfillment found a deletion-request Audit Event before recording one.',
    );
  }

  const lookup = await findUserById(pool, tenantId, subject.userId);
  if (lookup !== undefined) {
    throw new DeletionDrillInvariantError(
      'Operational lookup still returned the subject after soft-delete.',
    );
  }
  const byDestination = await findUserByDestination(pool, tenantId, subjectEmail);
  if (byDestination !== undefined) {
    throw new DeletionDrillInvariantError(
      'Destination lookup still returned the subject after soft-delete.',
    );
  }

  const raw = await pool.query<{ status: string; deleted_at: Date | null }>(
    `SELECT status, deleted_at FROM users WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, subject.userId],
  );
  const rawRow = raw.rows[0];
  if (rawRow === undefined || rawRow.status !== 'REVOKED' || rawRow.deleted_at === null) {
    throw new DeletionDrillInvariantError(
      'Soft-delete must retain the user row as REVOKED with deleted_at set ' +
        '(SUAS-specs SECURITY.md §2; DOMAIN_MODEL.md §2).',
    );
  }

  const sessionAfter = await resolveSession(pool, config.sessionSecret, issued.credential);
  if (sessionAfter.ok) {
    throw new DeletionDrillInvariantError(
      'Session remained usable after the subject was revoked (SUAS-specs AUTH.md §5).',
    );
  }

  const neighborAfter = await findUserById(pool, tenantId, neighbor.userId);
  if (neighborAfter === undefined || neighborAfter.status !== 'ACTIVE') {
    throw new DeletionDrillInvariantError(
      'Same-tenant neighbor was touched by the deletion drill.',
    );
  }
  const otherAfter = await findUserById(pool, otherTenantId, other.userId);
  if (otherAfter === undefined || otherAfter.status !== 'ACTIVE') {
    throw new DeletionDrillInvariantError('Cross-tenant user was touched by the deletion drill.');
  }

  const historyAfter = {
    domain: await countRows(pool, 'domain_events', tenantId, subject.userId),
    audit: await countRows(pool, 'audit_events', tenantId, subject.userId),
    consent: await countRows(pool, 'consent_events', tenantId, subject.userId),
  };
  if (historyAfter.domain < historyBefore.domain) {
    throw new DeletionDrillInvariantError(
      'Domain Events were purged; PRIVACY.md §10 forbids automatic event purge.',
    );
  }
  if (historyAfter.audit < historyBefore.audit + 1) {
    throw new DeletionDrillInvariantError(
      'Deletion-request Audit Event is missing, or prior audit history was purged.',
    );
  }
  if (historyAfter.consent < historyBefore.consent) {
    throw new DeletionDrillInvariantError(
      'Consent history was purged; CONSENT.md §4 and PRIVACY.md §2 require it to remain.',
    );
  }

  const replay = await withTransaction(pool, async (tx) => {
    await tx.query('SELECT set_config($1, $2, true)', [
      'statement_timeout',
      String(DELETION_DRILL_STATEMENT_TIMEOUT_MS),
    ]);
    return fulfillSyntheticDeletion(tx, {
      tenantId,
      userId: subject.userId,
      actorId: 'deletion-drill',
    });
  });
  if (replay.softDeleted || replay.sessionsRevoked !== 0 || !replay.requestDeduplicated) {
    throw new DeletionDrillInvariantError(
      'Replay must be a no-op: no second soft-delete, no extra session revoke, ' +
        'and exactly one deletion-request Audit Event.',
    );
  }
  if (replay.auditEventId !== first.auditEventId) {
    throw new DeletionDrillInvariantError('Replay recorded a second deletion-request Audit Event.');
  }

  const requestCount = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_events
     WHERE tenant_id = $1 AND event_type = $2 AND target_id = $3`,
    [tenantId, DELETION_REQUEST_AUDIT_EVENT_TYPE, subject.userId],
  );
  if ((requestCount.rows[0]?.n ?? 0) !== 1) {
    throw new DeletionDrillInvariantError(
      'Deletion request must be recorded exactly once for this subject.',
    );
  }

  return {
    status: 'ok',
    privacy_gate: PRIVACY_GATE_VERDICT,
    hipaa_claim: false,
    d007: D_007_RETENTION,
    provider_side_copies: PROVIDER_SIDE_COPIES,
    fulfillment: DELETION_FULFILLMENT,
    subject_user_id: subject.userId,
    tenant_id: tenantId,
    neighbor_user_id: neighbor.userId,
    other_tenant_id: otherTenantId,
    deletion_request_audit_event_id: first.auditEventId,
    operational_lookup_after: 'absent',
    row_retained: true,
    status_after: 'REVOKED',
    sessions_revoked: first.sessionsRevoked,
    history: {
      domain_events_retained: historyAfter.domain,
      audit_events_retained: historyAfter.audit,
      consent_events_retained: historyAfter.consent,
    },
    neighbor_untouched: true,
    other_tenant_untouched: true,
    replay: {
      soft_delete: 'no_op',
      sessions: 'no_op',
      request_recorded_once: true,
    },
    scale_note: 'single_logical_postgres',
    note: DRILL_NOTE,
  };
}

/**
 * Run the synthetic deletion drill against the supplied pool.
 *
 * Creates isolated synthetic users, records a deletion request, soft-deletes the
 * subject, proves history retention and tenant isolation, and replays the
 * fulfillment. The returned report never includes contact data.
 */
export async function runDeletionDrill(
  pool: Pool,
  config: SuasConfig,
  options: { readonly timeoutMs?: number } = {},
): Promise<DeletionDrillReport> {
  assertDeletionDrillEnvironment(config);
  const timeoutMs = options.timeoutMs ?? DELETION_DRILL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runDeletionDrillBody(pool, config),
      new Promise<DeletionDrillReport>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new DeletionDrillTimeoutError(timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
