/**
 * Time travel for the T-flows (build choice B1): each helper moves one stored timestamp into
 * the past, as if that much time had gone by. The job worker (`runJobWorkerOnce`) then runs the
 * sweeps that act on it. No product code changes; LOCAL e2e database only.
 */

import { withDb } from '../helpers';

/** Every release of this request happened `minutes` earlier (R8.5 restarts the widening wait). */
export async function ageReleases(serviceRequestId: string, minutes: number): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE chat_threads SET released_at = released_at - make_interval(mins => $2)
        WHERE service_request_id = $1 AND released_at IS NOT NULL`,
      [serviceRequestId, minutes],
    ),
  );
}

/** This Veteran's active grants reached their expiry a minute ago (CONSENT.md §7). */
export async function expireGrants(veteranUserId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE consent_grants SET expires_at = now() - interval '1 minute'
        WHERE veteran_user_id = $1 AND status = 'ACTIVE'`,
      [veteranUserId],
    ),
  );
}

/** This person's live sessions passed their absolute end a minute ago (AUTH.md §5). */
export async function expireSessions(userId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    ),
  );
}

/** This person's live sessions were last used three hours ago (the idle limit is two). */
export async function idleSessions(userId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE sessions SET last_seen_at = now() - interval '3 hours'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    ),
  );
}

/** This admin's MFA step-up happened 16 minutes ago (the elevation lasts 15). */
export async function ageElevation(userId: string): Promise<void> {
  await withDb((db) =>
    db.query(
      `UPDATE sessions SET mfa_elevated_at = now() - interval '16 minutes'
        WHERE user_id = $1 AND mfa_elevated_at IS NOT NULL AND revoked_at IS NULL`,
      [userId],
    ),
  );
}
