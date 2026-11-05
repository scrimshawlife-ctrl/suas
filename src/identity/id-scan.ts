/**
 * ID scan + selfie checks: the `veteran_verifications` records behind the gate.
 *
 * Plan citations: V1_PROJECT_PLAN.md §2.1 (every Veteran passes ID scan + selfie
 * before requesting help), §4.3 F2. The check itself runs behind the
 * `IdVerificationPort`; this module owns only the SUAS-side record, so no image,
 * score, or provider payload is ever stored.
 *
 * A person has a history of rows; the newest one is their current standing.
 * Starting is idempotent: an existing PENDING check is reused, a VERIFIED or
 * REVOKED standing is left alone, and only a person with no check, a
 * NOT_CONFIRMED check or an UNAVAILABLE check gets a new one.
 */

import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/transaction.js';
import { ID_CHECK_METHOD, type IdVerificationPort } from './id-verification.js';
import type { VeteranVerificationStatus } from './veteran-verification.js';

/** What a person's `me` view and the status route report. */
export type IdScanStatus = 'NOT_STARTED' | VeteranVerificationStatus;

export interface IdScanRecord {
  readonly verificationId: string;
  readonly status: VeteranVerificationStatus;
  readonly verifiedAt: Date | undefined;
  readonly providerCheckId: string | undefined;
}

export interface IdScanView {
  readonly status: IdScanStatus;
  readonly verifiedAt: Date | undefined;
}

interface IdScanRow {
  verification_id: string;
  status: VeteranVerificationStatus;
  verified_at: Date | null;
  provider_check_id: string | null;
}

const COLUMNS = 'verification_id, status, verified_at, provider_check_id';

function toRecord(row: IdScanRow): IdScanRecord {
  return {
    verificationId: row.verification_id,
    status: row.status,
    verifiedAt: row.verified_at ?? undefined,
    providerCheckId: row.provider_check_id ?? undefined,
  };
}

function toView(record: IdScanRecord | undefined): IdScanView {
  return record === undefined
    ? { status: 'NOT_STARTED', verifiedAt: undefined }
    : { status: record.status, verifiedAt: record.verifiedAt };
}

/** The person's newest ID scan record, if they ever started one. */
export async function findLatestIdScan(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<IdScanRecord | undefined> {
  const result = await db.query<IdScanRow>(
    `SELECT ${COLUMNS} FROM veteran_verifications
     WHERE tenant_id = $1 AND user_id = $2 AND method = $3
     ORDER BY created_at DESC, verification_id
     LIMIT 1`,
    [tenantId, userId, ID_CHECK_METHOD],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

/** True when the person's current standing is a passed ID scan + selfie check. */
export async function hasPassedIdScan(
  db: Queryable,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  return (await findLatestIdScan(db, tenantId, userId))?.status === 'VERIFIED';
}

export class IdVerificationUnavailableError extends Error {
  readonly code = 'ID_VERIFICATION_UNAVAILABLE';
  readonly httpStatus = 503;

  constructor() {
    super('ID verification is not available right now. Try again later.');
    this.name = 'IdVerificationUnavailableError';
  }
}

/** Ask the port about a PENDING check and record a final answer. Unchanged otherwise. */
async function settlePending(
  db: Queryable,
  port: IdVerificationPort,
  record: IdScanRecord,
): Promise<IdScanRecord> {
  if (record.status !== 'PENDING' || record.providerCheckId === undefined) return record;
  const outcome = await port.readOutcome(record.providerCheckId);
  // PENDING and UNAVAILABLE are not answers: a provider hiccup must not fail a person.
  if (outcome.status !== 'VERIFIED' && outcome.status !== 'NOT_CONFIRMED') return record;
  const updated = await db.query<IdScanRow>(
    `UPDATE veteran_verifications
        SET status = $2::suas_veteran_verification_status,
            verified_at = CASE
              WHEN $2::suas_veteran_verification_status = 'VERIFIED' THEN now()
            END
      WHERE verification_id = $1 AND status = 'PENDING'
      RETURNING ${COLUMNS}`,
    [record.verificationId, outcome.status],
  );
  const row = updated.rows[0];
  return row === undefined ? record : toRecord(row);
}

/**
 * The person's current ID scan standing, resolving a PENDING check with the port
 * when one is configured.
 */
export async function readIdScanStatus(
  db: Queryable,
  port: IdVerificationPort | undefined,
  tenantId: string,
  userId: string,
): Promise<IdScanView> {
  const latest = await findLatestIdScan(db, tenantId, userId);
  if (latest === undefined || port === undefined) return toView(latest);
  return toView(await settlePending(db, port, latest));
}

/** Open (or retry opening) the provider check behind a PENDING row. */
async function openProviderCheck(
  db: Queryable,
  port: IdVerificationPort,
  tenantId: string,
  userId: string,
  record: IdScanRecord,
): Promise<IdScanRecord> {
  // The row id is the port's idempotency key, so a retry cannot open a second check.
  const started = await port.startCheck({
    subjectId: userId,
    idempotencyKey: record.verificationId,
  });
  const updated =
    started.status === 'PENDING'
      ? await db.query<IdScanRow>(
          `UPDATE veteran_verifications SET provider_check_id = $2
            WHERE verification_id = $1 AND tenant_id = $3 AND status = 'PENDING'
            RETURNING ${COLUMNS}`,
          [record.verificationId, started.checkId, tenantId],
        )
      : await db.query<IdScanRow>(
          `UPDATE veteran_verifications SET status = 'UNAVAILABLE'
            WHERE verification_id = $1 AND tenant_id = $2 AND status = 'PENDING'
            RETURNING ${COLUMNS}`,
          [record.verificationId, tenantId],
        );
  const row = updated.rows[0];
  return row === undefined ? record : toRecord(row);
}

/**
 * Start an ID scan + selfie check. Returns the current standing and whether a new
 * check was opened by this call. Throws IdVerificationUnavailableError when the
 * port is disabled or reports the provider unavailable.
 */
export async function startIdScan(
  db: Queryable,
  port: IdVerificationPort | undefined,
  tenantId: string,
  userId: string,
): Promise<{ view: IdScanView; created: boolean }> {
  if (port === undefined) throw new IdVerificationUnavailableError();

  const latest = await findLatestIdScan(db, tenantId, userId);
  if (latest?.status === 'VERIFIED' || latest?.status === 'REVOKED') {
    return { view: toView(latest), created: false };
  }

  let current = latest?.status === 'PENDING' ? latest : undefined;
  let created = false;
  if (current === undefined) {
    const inserted = await db.query<IdScanRow>(
      `INSERT INTO veteran_verifications
         (verification_id, tenant_id, user_id, method, status, source, source_contract_version)
       VALUES ($1, $2, $3, $4, 'PENDING', 'SUAS', $5)
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [randomUUID(), tenantId, userId, ID_CHECK_METHOD, port.implementation],
    );
    const row = inserted.rows[0];
    // A concurrent start won the one-PENDING-per-person slot; reuse its row.
    current = row === undefined ? await findLatestIdScan(db, tenantId, userId) : toRecord(row);
    created = row !== undefined;
  }
  if (current === undefined) throw new IdVerificationUnavailableError();

  if (current.status === 'PENDING' && current.providerCheckId === undefined) {
    current = await openProviderCheck(db, port, tenantId, userId, current);
    if (current.status === 'UNAVAILABLE') throw new IdVerificationUnavailableError();
  }
  return { view: toView(await settlePending(db, port, current)), created };
}
