/**
 * Synthetic deletion-drill path evidence (requires PostgreSQL).
 *
 * SUAS-specs PRIVACY.md §2, §9, §10; SECURITY.md §2; AUTH.md §5;
 * CONSENT.md §4; TESTING.md §12; ENVIRONMENT.md §2.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { loadConfig } from '../../src/config/index.js';
import {
  DELETION_REQUEST_AUDIT_EVENT_TYPE,
  runDeletionDrill,
} from '../../src/privacy/deletion-drill.js';
import { findUserById } from '../../src/identity/index.js';
import { scanForNonSyntheticContactData } from '../../src/testing/fixture-boundary.js';
import { createTestPool, resetKernelTables } from '../helpers/db.js';
import { TEST_SESSION_SECRET, testDatabaseUrl, validEnv } from '../helpers/env.js';

const pool: Pool = createTestPool();
const config = loadConfig(
  validEnv({
    DATABASE_URL: testDatabaseUrl(),
    SUAS_SESSION_SECRET: TEST_SESSION_SECRET,
  }),
);

beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});

describe('PRIVACY.md §10 — synthetic deletion path', () => {
  it('records a deletion request, soft-deletes the subject, and retains history', async () => {
    const report = await runDeletionDrill(pool, config);

    expect(report.status).toBe('ok');
    expect(report.privacy_gate).toBe('NOT_READY');
    expect(report.hipaa_claim).toBe(false);
    expect(report.d007).toBe('DECISION_PENDING');
    expect(report.provider_side_copies).toBe('NOT_COMPUTABLE');
    expect(report.fulfillment).toBe('SOFT_DELETE_OPERATIONAL_ROW');
    expect(report.operational_lookup_after).toBe('absent');
    expect(report.row_retained).toBe(true);
    expect(report.status_after).toBe('REVOKED');
    expect(report.sessions_revoked).toBeGreaterThanOrEqual(1);
    expect(report.history.domain_events_retained).toBeGreaterThanOrEqual(1);
    expect(report.history.audit_events_retained).toBeGreaterThanOrEqual(2);
    expect(report.history.consent_events_retained).toBeGreaterThanOrEqual(1);
    expect(report.neighbor_untouched).toBe(true);
    expect(report.other_tenant_untouched).toBe(true);
    expect(report.replay).toEqual({
      soft_delete: 'no_op',
      sessions: 'no_op',
      request_recorded_once: true,
    });
    expect(report.scale_note).toBe('single_logical_postgres');

    expect(await findUserById(pool, report.tenant_id, report.subject_user_id)).toBeUndefined();
    expect(await findUserById(pool, report.tenant_id, report.neighbor_user_id)).toMatchObject({
      status: 'ACTIVE',
    });

    const request = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_events
       WHERE tenant_id = $1 AND event_type = $2 AND target_id = $3`,
      [report.tenant_id, DELETION_REQUEST_AUDIT_EVENT_TYPE, report.subject_user_id],
    );
    expect(request.rows[0]?.n).toBe(1);

    const payload = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM audit_events WHERE audit_event_id = $1`,
      [report.deletion_request_audit_event_id],
    );
    expect(payload.rows[0]?.payload).toMatchObject({
      fulfillment: 'SOFT_DELETE_OPERATIONAL_ROW',
      d007: 'DECISION_PENDING',
      provider_side_copies: 'NOT_COMPUTABLE',
      automatic_event_purge: false,
    });

    const serialized = JSON.stringify(report);
    expect(scanForNonSyntheticContactData(serialized)).toEqual([]);
    expect(serialized).not.toMatch(/@/);
    expect(serialized).not.toMatch(/HIPAA compliant/i);
  });
});
