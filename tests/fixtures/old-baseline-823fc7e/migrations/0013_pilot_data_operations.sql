-- 0013_pilot_data_operations.sql — D-007 approved pilot operations (2026-08-29).
-- Pilot-only operational evidence. It never authorizes a provider, recipient, or
-- external delivery. Immutable Audit Events remain the authoritative audit trail.
CREATE TYPE suas_data_operation_kind AS ENUM ('EXPORT', 'DELETION', 'RETENTION_PURGE');
CREATE TYPE suas_data_operation_status AS ENUM ('RECEIVED', 'VERIFIED', 'AUTHORIZED', 'COMPLETED', 'BLOCKED');

CREATE TABLE data_operation_requests (
    data_operation_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    subject_user_id uuid NOT NULL,
    kind suas_data_operation_kind NOT NULL,
    status suas_data_operation_status NOT NULL DEFAULT 'RECEIVED',
    request_id text NOT NULL,
    verifier text,
    authorizer text,
    affected_systems jsonb NOT NULL DEFAULT '[]'::jsonb,
    provider_receipts jsonb NOT NULL DEFAULT '[]'::jsonb,
    exceptions jsonb NOT NULL DEFAULT '[]'::jsonb,
    completed_at timestamptz,
    requester_notified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, request_id),
    FOREIGN KEY (subject_user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    CHECK ((status IN ('VERIFIED', 'AUTHORIZED', 'COMPLETED') AND verifier IS NOT NULL) OR status IN ('RECEIVED', 'BLOCKED')),
    CHECK ((status IN ('AUTHORIZED', 'COMPLETED') AND authorizer IS NOT NULL) OR status IN ('RECEIVED', 'VERIFIED', 'BLOCKED'))
);
CREATE INDEX data_operation_requests_subject_idx ON data_operation_requests (tenant_id, subject_user_id, created_at DESC);
CREATE INDEX data_operation_requests_retention_idx ON data_operation_requests (kind, status, completed_at) WHERE kind = 'RETENTION_PURGE';
