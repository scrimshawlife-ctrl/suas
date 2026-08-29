/** D-007 approved pilot data operations. No provider or delivery adapter is activated. */
import { createCipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction, type Queryable } from '../db/transaction.js';
import { appendAuditEvent } from '../events/index.js';

export const PILOT_DATA_OPERATIONS_VERDICT = 'NOT_READY' as const;
export const DATA_OPERATION_AFFECTED_SYSTEMS = [
  'system_of_record',
  'search_indexes',
  'caches',
  'attachments',
  'durable_jobs',
  'covered_downstream_processors',
] as const;
export type DataOperationKind = 'EXPORT' | 'DELETION' | 'RETENTION_PURGE';
export type DataOperationStatus = 'RECEIVED' | 'VERIFIED' | 'AUTHORIZED' | 'COMPLETED' | 'BLOCKED';
const requestSchema = z.object({
  tenantId: z.string().uuid(),
  subjectUserId: z.string().uuid(),
  kind: z.enum(['EXPORT', 'DELETION', 'RETENTION_PURGE']),
  requestId: z.string().min(1).max(200),
  verifier: z.string().min(1).max(200),
  authorizer: z.string().min(1).max(200),
  affectedSystems: z.array(z.enum(DATA_OPERATION_AFFECTED_SYSTEMS)).min(1),
  exceptions: z.array(z.string().max(500)).default([]),
  actorId: z.string().min(1).max(200),
});
export type CreateDataOperationInput = z.input<typeof requestSchema>;
export interface DataOperationRecord {
  readonly dataOperationId: string;
  readonly status: DataOperationStatus;
  readonly requestId: string;
}

export async function authorizeDataOperation(
  pool: Pool,
  raw: CreateDataOperationInput,
): Promise<DataOperationRecord> {
  const input = requestSchema.parse(raw);
  return withTransaction(pool, async (tx) => {
    const existing = await tx.query<{ data_operation_id: string; status: DataOperationStatus }>(
      'SELECT data_operation_id, status FROM data_operation_requests WHERE tenant_id=$1 AND request_id=$2',
      [input.tenantId, input.requestId],
    );
    if (existing.rows[0])
      return {
        dataOperationId: existing.rows[0].data_operation_id,
        status: existing.rows[0].status,
        requestId: input.requestId,
      };
    const id = randomUUID();
    await tx.query(
      `INSERT INTO data_operation_requests (data_operation_id,tenant_id,subject_user_id,kind,status,request_id,verifier,authorizer,affected_systems,exceptions) VALUES ($1,$2,$3,$4,'AUTHORIZED',$5,$6,$7,$8,$9)`,
      [
        id,
        input.tenantId,
        input.subjectUserId,
        input.kind,
        input.requestId,
        input.verifier,
        input.authorizer,
        JSON.stringify(input.affectedSystems),
        JSON.stringify(input.exceptions),
      ],
    );
    await audit(tx, input, 'DATA_OPERATION_AUTHORIZED', id, {
      kind: input.kind,
      request_id: input.requestId,
      verifier: input.verifier,
      authorizer: input.authorizer,
      affected_systems: input.affectedSystems,
      exceptions: input.exceptions,
    });
    return { dataOperationId: id, status: 'AUTHORIZED', requestId: input.requestId };
  });
}
async function audit(
  tx: Queryable,
  input: Pick<CreateDataOperationInput, 'tenantId' | 'subjectUserId' | 'actorId'>,
  eventType: string,
  id: string,
  payload: Record<string, unknown>,
) {
  await appendAuditEvent(tx, {
    eventType,
    action: 'RECORD',
    targetType: 'data_operation',
    targetId: id,
    aggregateType: 'User',
    aggregateId: input.subjectUserId,
    tenantId: input.tenantId,
    actorType: 'SYSTEM',
    actorId: input.actorId,
    payload: payload as never,
  });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
function csv(rows: readonly Record<string, unknown>[]): string {
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();
  const esc = (v: unknown) => {
    let cell = '';
    if (typeof v === 'string') cell = v;
    else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      cell = String(v);
    } else if (v !== null && typeof v === 'object') {
      cell = canonical(v);
    }
    return `"${cell.replaceAll('"', '""')}"`;
  };
  return [keys.map(esc).join(','), ...rows.map((r) => keys.map((k) => esc(r[k])).join(','))].join(
    '\n',
  );
}
export interface EncryptedExport {
  readonly contentType: 'application/vnd.suas.encrypted-export+json';
  readonly encryption: 'AES-256-GCM';
  readonly manifest: {
    readonly schema_version: '1';
    readonly generated_at: string;
    readonly provenance: string;
    readonly checksums: Record<string, string>;
  };
  readonly ciphertext: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
}
/** Builds an encrypted pre-delivery export package. Caller owns approved single-use delivery; this function has no network effect. */
export async function buildPilotExport(
  pool: Pool,
  input: CreateDataOperationInput & { readonly encryptionKey: Buffer },
): Promise<EncryptedExport> {
  const op = await authorizeDataOperation(pool, { ...input, kind: 'EXPORT' });
  if (input.encryptionKey.length !== 32)
    throw new Error('D-007 export requires a 32-byte AES-256 key.');
  const datasets: Record<string, Record<string, unknown>[]> = {};
  for (const [name, sql] of Object.entries({
    users:
      'SELECT user_id,tenant_id,email,phone,status,created_at,updated_at FROM users WHERE tenant_id=$1 AND user_id=$2',
    domain_events: 'SELECT * FROM domain_events WHERE tenant_id=$1 AND aggregate_id=$2',
    audit_events: 'SELECT * FROM audit_events WHERE tenant_id=$1 AND aggregate_id=$2',
    consent_events: 'SELECT * FROM consent_events WHERE tenant_id=$1 AND veteran_user_id=$2',
    consent_grants: 'SELECT * FROM consent_grants WHERE tenant_id=$1 AND veteran_user_id=$2',
  })) {
    datasets[name] = (
      await pool.query<Record<string, unknown>>(sql, [input.tenantId, input.subjectUserId])
    ).rows;
  }
  const files: Record<string, string> = {};
  for (const [n, r] of Object.entries(datasets)) {
    files[`${n}.json`] = canonical(r);
    files[`${n}.csv`] = csv(r);
  }
  const checksums = Object.fromEntries(
    Object.entries(files).map(([n, v]) => [n, createHash('sha256').update(v).digest('hex')]),
  );
  const manifest = {
    schema_version: '1' as const,
    generated_at: new Date().toISOString(),
    provenance: 'SUAS D-007 pilot data operations; no external delivery',
    checksums,
  };
  const plaintext = Buffer.from(canonical({ manifest, files }));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', input.encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  await withTransaction(pool, async (tx) => {
    await tx.query(
      "UPDATE data_operation_requests SET status='COMPLETED', completed_at=now(), updated_at=now() WHERE data_operation_id=$1",
      [op.dataOperationId],
    );
    await audit(tx, input, 'DATA_EXPORT_COMPLETED', op.dataOperationId, {
      request_id: input.requestId,
      encryption: 'AES-256-GCM',
      schema_version: '1',
      checksums,
      delivery: 'NOT_ACTIVATED',
    });
  });
  return {
    contentType: 'application/vnd.suas.encrypted-export+json',
    encryption: 'AES-256-GCM',
    manifest,
    ciphertext,
    iv,
    authTag,
  };
}
/** Finds event records eligible after D-007's 365-day retention window. It deliberately does not purge immutable event stores. */
export async function planRetentionPurge(
  pool: Pool,
  before: Date,
): Promise<{
  readonly eligibleEventCount: number;
  readonly action: 'MANUAL_REVIEW_REQUIRED';
  readonly reason: string;
}> {
  const r = await pool.query<{ n: number }>(
    'SELECT count(*)::int n FROM (SELECT event_id FROM domain_events WHERE occurred_at < $1 UNION ALL SELECT audit_event_id FROM audit_events WHERE occurred_at < $1 UNION ALL SELECT consent_event_id FROM consent_events WHERE occurred_at < $1) events',
    [before],
  );
  return {
    eligibleEventCount: r.rows[0]?.n ?? 0,
    action: 'MANUAL_REVIEW_REQUIRED',
    reason:
      'Event stores are append-only. D-007 requires retained history and no destructive purge is performed automatically.',
  };
}
