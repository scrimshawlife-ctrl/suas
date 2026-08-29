/** D-007 pilot data operations: audited, tenant-scoped, no external delivery. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { createTestPool, resetKernelTables, syntheticTenantId } from '../helpers/db.js';
import { createUser } from '../../src/identity/index.js';
import {
  authorizeDataOperation,
  buildPilotExport,
  planRetentionPurge,
  recordProviderDeletionOutcome,
} from '../../src/privacy/index.js';
const pool: Pool = createTestPool();
beforeEach(() => resetKernelTables(pool));
afterAll(async () => {
  await resetKernelTables(pool);
  await pool.end();
});
describe('D-007 approved pilot data operations', () => {
  it('records verifier, authorizer, coverage, and idempotently audits an operation', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, {
      tenantId,
      email: 'd007-operation@synthetic.suas.test',
      status: 'ACTIVE',
    });
    const input = {
      tenantId: user.tenantId,
      subjectUserId: user.userId,
      kind: 'DELETION' as const,
      requestId: 'd007-request-1',
      verifier: 'verified-account-channel',
      authorizer: 'privacy-lead',
      affectedSystems: ['system_of_record', 'durable_jobs'] as Array<
        'system_of_record' | 'durable_jobs'
      >,
      actorId: 'privacy-operations',
    };
    const parent = await pool.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM users WHERE user_id = $1',
      [user.userId],
    );
    expect(parent.rows[0]?.tenant_id).toBe(user.tenantId);
    const one = await authorizeDataOperation(pool, input);
    const two = await authorizeDataOperation(pool, input);
    expect(two).toEqual(one);
    const row = await pool.query<{
      status: string;
      verifier: string;
      authorizer: string;
      affected_systems: string[];
    }>(
      'SELECT status, verifier, authorizer, affected_systems FROM data_operation_requests WHERE data_operation_id=$1',
      [one.dataOperationId],
    );
    expect(row.rows[0]).toMatchObject({
      status: 'AUTHORIZED',
      verifier: 'verified-account-channel',
      authorizer: 'privacy-lead',
      affected_systems: ['system_of_record', 'durable_jobs'],
    });
    const audit = await pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM audit_events WHERE event_type=$1 AND target_id=$2',
      ['DATA_OPERATION_AUTHORIZED', one.dataOperationId],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });
  it('builds an encrypted export with manifest and checksums without an external delivery', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, {
      tenantId,
      email: 'd007-export@synthetic.suas.test',
      status: 'ACTIVE',
    });
    const key = randomBytes(32);
    const result = await buildPilotExport(pool, {
      tenantId: user.tenantId,
      subjectUserId: user.userId,
      kind: 'EXPORT',
      requestId: 'd007-export-1',
      verifier: 'verified-account-channel',
      authorizer: 'privacy-lead',
      affectedSystems: ['system_of_record'],
      actorId: 'privacy-operations',
      encryptionKey: key,
    });
    expect(result.encryption).toBe('AES-256-GCM');
    expect(Object.keys(result.manifest.checksums)).toContain('users.json');
    const d = createDecipheriv('aes-256-gcm', key, result.iv);
    d.setAuthTag(result.authTag);
    const plaintext = Buffer.concat([d.update(result.ciphertext), d.final()]).toString();
    expect(plaintext).toContain('d007-export@synthetic.suas.test');
    const audit = await pool.query<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM audit_events WHERE event_type=$1',
      ['DATA_EXPORT_COMPLETED'],
    );
    expect(audit.rows[0]?.payload).toMatchObject({
      delivery: 'NOT_ACTIVATED',
      encryption: 'AES-256-GCM',
    });
  });
  it('plans but never automatically purges immutable event stores', async () => {
    expect(await planRetentionPurge(pool, new Date())).toMatchObject({
      action: 'MANUAL_REVIEW_REQUIRED',
    });
  });
  it('records an approved provider deletion outcome without calling a provider', async () => {
    const tenantId = syntheticTenantId();
    const user = await createUser(pool, {
      tenantId,
      email: 'd007-provider-outcome@synthetic.suas.test',
      status: 'ACTIVE',
    });
    const operation = await authorizeDataOperation(pool, {
      tenantId,
      subjectUserId: user.userId,
      kind: 'DELETION',
      requestId: 'd007-provider-outcome-1',
      verifier: 'verified-account-channel',
      authorizer: 'privacy-lead',
      affectedSystems: ['covered_downstream_processors'],
      actorId: 'privacy-operations',
    });
    await recordProviderDeletionOutcome(pool, {
      tenantId,
      subjectUserId: user.userId,
      dataOperationId: operation.dataOperationId,
      actorId: 'privacy-operations',
      providerReference: 'opaque-synthetic-provider-reference',
      outcome: 'BACKUP_EXPIRY_PENDING',
    });
    const recorded = await pool.query<{ provider_receipts: unknown[] }>(
      'SELECT provider_receipts FROM data_operation_requests WHERE data_operation_id=$1',
      [operation.dataOperationId],
    );
    expect(recorded.rows[0]?.provider_receipts).toEqual([
      {
        provider_reference: 'opaque-synthetic-provider-reference',
        outcome: 'BACKUP_EXPIRY_PENDING',
      },
    ]);
    const audit = await pool.query<{ n: number }>(
      'SELECT count(*)::int n FROM audit_events WHERE event_type=$1 AND target_id=$2',
      ['DATA_OPERATION_PROVIDER_DELETION_RECORDED', operation.dataOperationId],
    );
    expect(audit.rows[0]?.n).toBe(1);
  });
});
