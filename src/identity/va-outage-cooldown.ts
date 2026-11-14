/**
 * The shared VA outage cooldown (suas #287, AT09; the delegated choice in the 2026-11-13
 * packet, proposal), kept in the database because API and worker Lambdas share no memory.
 * 3 transport outages in a row close VA for 60 seconds; then one request is the probe: a VA
 * answer closes the cooldown, another outage opens it again. Modelled on the licence breaker.
 */

import type { Queryable } from '../db/transaction.js';
import type { VaConfirmationFailureClass, VeteranConfirmationResult } from './va-confirmation.js';

export const VA_OUTAGE_COOLDOWN_SECONDS = 60;
export const VA_OUTAGE_THRESHOLD = 3;
/** A probe whose process died is given up after this, so the cooldown cannot stick. */
const PROBE_STALE_SECONDS = 120;
const ID = 'va-confirmation';
/** Transport failures: an HTTP 5xx, a timeout, a network failure. A VA 400 is not one. */
const OUTAGE_CLASSES: ReadonlySet<VaConfirmationFailureClass> = new Set([
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'NETWORK_ERROR',
]);

/**
 * True when VA could not be reached. A 200 body answering ERROR for one lookup is also
 * PROVIDER_UNAVAILABLE but carries that reason, so one person's lookup cannot pause VA.
 */
const isTransportOutage = (result: VeteranConfirmationResult | undefined): boolean =>
  result?.failureClass !== undefined &&
  OUTAGE_CLASSES.has(result.failureClass) &&
  result.notConfirmedReason === undefined;

/**
 * May this request call VA now? `closed`: yes. `probe`: yes, as the one probe after the
 * cooldown. `open`: no.
 */
export async function acquireVaCall(db: Queryable): Promise<'closed' | 'probe' | 'open'> {
  const probe = await db.query(
    `UPDATE va_outage_cooldown
        SET probe_started_at = now(), updated_at = now()
      WHERE cooldown_id = $1 AND opened_at IS NOT NULL
        AND opened_at <= now() - make_interval(secs => $2)
        AND (probe_started_at IS NULL OR probe_started_at < now() - make_interval(secs => $3))
      RETURNING 1`,
    [ID, VA_OUTAGE_COOLDOWN_SECONDS, PROBE_STALE_SECONDS],
  );
  if ((probe.rowCount ?? 0) > 0) return 'probe';
  const state = await db.query<{ opened_at: Date | null }>(
    `SELECT opened_at FROM va_outage_cooldown WHERE cooldown_id = $1`,
    [ID],
  );
  const openedAt = state.rows[0]?.opened_at;
  return openedAt === undefined || openedAt === null ? 'closed' : 'open';
}

/**
 * Records what an admitted request learned: a transport outage counts, and the third in a row
 * (or a failed probe) opens the cooldown; a VA answer resets the count and closes it. A probe
 * with any other outcome, or no VA call (`undefined`), hands its turn back.
 */
export async function recordVaCallOutcome(
  db: Queryable,
  result: VeteranConfirmationResult | undefined,
  probe: boolean,
): Promise<void> {
  const answered = result?.status === 'VERIFIED' || result?.status === 'NOT_CONFIRMED';
  const outage = isTransportOutage(result);
  if (!answered && !outage && !probe) return;
  await db.query(
    `UPDATE va_outage_cooldown
        SET consecutive_failures = CASE WHEN $2 THEN consecutive_failures + 1
                                        WHEN $3 THEN 0 ELSE consecutive_failures END,
            opened_at = CASE
              WHEN $2 AND ($4 OR consecutive_failures + 1 >= $5) THEN now()
              WHEN $3 THEN NULL
              ELSE opened_at END,
            probe_started_at = NULL, updated_at = now()
      WHERE cooldown_id = $1`,
    [ID, outage, answered, probe, VA_OUTAGE_THRESHOLD],
  );
}
