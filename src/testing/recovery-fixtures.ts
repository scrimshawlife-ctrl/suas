import type { Pool } from 'pg';

export const RECOVERY_FIXTURE_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const RECOVERY_FIXTURE_VERSION = 'recovery-drill-v1';

const FIXTURES = [
  {
    jobId: '10000000-0000-4000-8000-000000000001',
    name: 'queued_due',
    status: 'PENDING',
    attempts: 0,
    maxAttempts: 5,
    runOffsetMs: -10 * 60_000,
    leaseOffsetMs: null,
    leaseOwner: null,
    lastError: null,
  },
  {
    jobId: '10000000-0000-4000-8000-000000000002',
    name: 'scheduled',
    status: 'PENDING',
    attempts: 0,
    maxAttempts: 5,
    runOffsetMs: 24 * 60 * 60_000,
    leaseOffsetMs: null,
    leaseOwner: null,
    lastError: null,
  },
  {
    jobId: '10000000-0000-4000-8000-000000000003',
    name: 'leased_active',
    status: 'LEASED',
    attempts: 1,
    maxAttempts: 5,
    runOffsetMs: -10 * 60_000,
    leaseOffsetMs: 5 * 60_000,
    leaseOwner: 'recovery-fixture-active',
    lastError: null,
  },
  {
    jobId: '10000000-0000-4000-8000-000000000004',
    name: 'leased_expired',
    status: 'LEASED',
    attempts: 2,
    maxAttempts: 5,
    runOffsetMs: -10 * 60_000,
    leaseOffsetMs: -5 * 60_000,
    leaseOwner: 'recovery-fixture-expired',
    lastError: 'synthetic expired lease',
  },
  {
    jobId: '10000000-0000-4000-8000-000000000005',
    name: 'succeeded',
    status: 'SUCCEEDED',
    attempts: 1,
    maxAttempts: 5,
    runOffsetMs: -20 * 60_000,
    leaseOffsetMs: null,
    leaseOwner: null,
    lastError: null,
  },
  {
    jobId: '10000000-0000-4000-8000-000000000006',
    name: 'retry_pending',
    status: 'PENDING',
    attempts: 2,
    maxAttempts: 5,
    runOffsetMs: 60_000,
    leaseOffsetMs: null,
    leaseOwner: null,
    lastError: 'synthetic retryable failure',
  },
  {
    jobId: '10000000-0000-4000-8000-000000000007',
    name: 'dead_letter',
    status: 'DEAD_LETTER',
    attempts: 3,
    maxAttempts: 3,
    runOffsetMs: -30 * 60_000,
    leaseOffsetMs: null,
    leaseOwner: null,
    lastError: 'synthetic terminal failure',
  },
] as const;

export interface RecoveryFixtureSummary {
  readonly version: typeof RECOVERY_FIXTURE_VERSION;
  readonly tenantId: string;
  readonly total: number;
  readonly statuses: Readonly<Record<'PENDING' | 'LEASED' | 'SUCCEEDED' | 'DEAD_LETTER', number>>;
}

/**
 * Install deterministic synthetic durable-job states before a recovery snapshot.
 *
 * The fixture payload contains no identity or provider data. Re-running replaces
 * the same seven rows, so a drill cannot multiply work or observable effects.
 */
export async function seedRecoveryFixtures(
  pool: Pool,
  options: { readonly tenantId?: string; readonly now?: Date } = {},
): Promise<RecoveryFixtureSummary> {
  const tenantId = options.tenantId ?? RECOVERY_FIXTURE_TENANT_ID;
  const now = options.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const fixture of FIXTURES) {
      const runAt = new Date(now.getTime() + fixture.runOffsetMs);
      const leasedUntil =
        fixture.leaseOffsetMs === null ? null : new Date(now.getTime() + fixture.leaseOffsetMs);
      await client.query(
        `INSERT INTO job_outbox (
           job_id, tenant_id, job_type, payload, idempotency_key, status,
           attempts, max_attempts, run_at, leased_until, lease_owner, last_error
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (job_id) DO UPDATE SET
           tenant_id = EXCLUDED.tenant_id,
           job_type = EXCLUDED.job_type,
           payload = EXCLUDED.payload,
           idempotency_key = EXCLUDED.idempotency_key,
           status = EXCLUDED.status,
           attempts = EXCLUDED.attempts,
           max_attempts = EXCLUDED.max_attempts,
           run_at = EXCLUDED.run_at,
           leased_until = EXCLUDED.leased_until,
           lease_owner = EXCLUDED.lease_owner,
           last_error = EXCLUDED.last_error,
           updated_at = now()`,
        [
          fixture.jobId,
          tenantId,
          `synthetic.recovery.${fixture.name}`,
          JSON.stringify({ fixture: RECOVERY_FIXTURE_VERSION, state: fixture.name }),
          `${RECOVERY_FIXTURE_VERSION}:${fixture.name}`,
          fixture.status,
          fixture.attempts,
          fixture.maxAttempts,
          runAt.toISOString(),
          leasedUntil?.toISOString() ?? null,
          fixture.leaseOwner,
          fixture.lastError,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  const statuses = { PENDING: 0, LEASED: 0, SUCCEEDED: 0, DEAD_LETTER: 0 };
  for (const fixture of FIXTURES) statuses[fixture.status] += 1;
  return { version: RECOVERY_FIXTURE_VERSION, tenantId, total: FIXTURES.length, statuses };
}
