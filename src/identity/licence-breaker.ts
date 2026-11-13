/**
 * The licence reader's circuit breaker (suas-specs R10.1, proposal; L4.6), kept in the
 * database because API and worker Lambdas share no memory. It opens after 5 reader-
 * unavailable outcomes in a row; while open the licence path is closed. After 15 minutes
 * the path reopens and the next read is a single probe: success closes the breaker,
 * failure opens it again.
 */

import type { Queryable } from '../db/transaction.js';

export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_COOLDOWN_SECONDS = 15 * 60;
/** A probe whose worker died is given up after this, so the breaker cannot stick half-open. */
const PROBE_STALE_SECONDS = 180;
const ID = 'licence-reader';

/** False only while the breaker is open and its cooldown has not passed. */
export async function isReaderPathOpen(db: Queryable): Promise<boolean> {
  const result = await db.query<{ open: boolean }>(
    `SELECT opened_at IS NULL OR opened_at <= now() - make_interval(secs => $2) AS open
       FROM licence_reader_breaker WHERE breaker_id = $1`,
    [ID, BREAKER_COOLDOWN_SECONDS],
  );
  return result.rows[0]?.open ?? true;
}

/**
 * May the worker call the reader now? `closed`: yes. `probe`: yes, as the one probe after
 * the cooldown. `open`: no.
 */
export async function acquireReaderCall(db: Queryable): Promise<'closed' | 'probe' | 'open'> {
  const probe = await db.query(
    `UPDATE licence_reader_breaker
        SET probe_started_at = now(), updated_at = now()
      WHERE breaker_id = $1 AND opened_at IS NOT NULL
        AND opened_at <= now() - make_interval(secs => $2)
        AND (probe_started_at IS NULL OR probe_started_at < now() - make_interval(secs => $3))
      RETURNING 1`,
    [ID, BREAKER_COOLDOWN_SECONDS, PROBE_STALE_SECONDS],
  );
  if ((probe.rowCount ?? 0) > 0) return 'probe';
  const state = await db.query<{ opened_at: Date | null }>(
    `SELECT opened_at FROM licence_reader_breaker WHERE breaker_id = $1`,
    [ID],
  );
  const openedAt = state.rows[0]?.opened_at;
  return openedAt === undefined || openedAt === null ? 'closed' : 'open';
}

/** The reader answered: the breaker closes and the count restarts. */
export async function recordReaderAnswer(db: Queryable): Promise<void> {
  await db.query(
    `UPDATE licence_reader_breaker
        SET consecutive_failures = 0, opened_at = NULL, probe_started_at = NULL, updated_at = now()
      WHERE breaker_id = $1`,
    [ID],
  );
}

/**
 * The reader did not answer. A failed probe opens the breaker again at once. `settled`
 * marks the review's final outcome (after its retries); only those count toward the 5.
 */
export async function recordReaderUnavailable(
  db: Queryable,
  input: { readonly probe: boolean; readonly settled: boolean },
): Promise<void> {
  await db.query(
    `UPDATE licence_reader_breaker
        SET consecutive_failures = consecutive_failures + CASE WHEN $2 THEN 1 ELSE 0 END,
            opened_at = CASE
              WHEN $3 OR consecutive_failures + CASE WHEN $2 THEN 1 ELSE 0 END >= $4 THEN now()
              ELSE opened_at END,
            probe_started_at = NULL,
            updated_at = now()
      WHERE breaker_id = $1`,
    [ID, input.settled, input.probe, BREAKER_FAILURE_THRESHOLD],
  );
}
