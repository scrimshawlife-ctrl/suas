-- Migration 0012: durable job outbox (D-022 Postgres outbox / SKIP LOCKED)
--
-- Spec citations:
-- - ARCHITECTURE.md §3 invariant 5 (production-critical async survives restart)
-- - ARCHITECTURE.md §8 durable background work (D-022 product = Postgres outbox)
-- - ARCHITECTURE.md §10 (stable logical identity / idempotency)
-- - ARCHITECTURE.md §13 (bounded attempts)
--
-- Distinct from event_outbox (tied to domain_events). This table carries
-- DurableJobQueuePort work (Support Signal compute, notification delivery, etc.).

CREATE TYPE suas_job_status AS ENUM (
    'PENDING',
    'LEASED',
    'SUCCEEDED',
    'DEAD_LETTER'
);

CREATE TABLE job_outbox (
    job_id           uuid              PRIMARY KEY,
    -- Text (not uuid): DurableJobQueuePort.tenantId is an opaque scope string.
    tenant_id        text,
    job_type         text              NOT NULL,
    payload          jsonb             NOT NULL,
    idempotency_key  text,
    status           suas_job_status   NOT NULL DEFAULT 'PENDING',
    attempts         integer           NOT NULL DEFAULT 0,
    max_attempts     integer           NOT NULL DEFAULT 5,
    run_at           timestamptz       NOT NULL DEFAULT now(),
    leased_until     timestamptz,
    lease_owner      text,
    last_error       text,
    created_at       timestamptz       NOT NULL DEFAULT now(),
    updated_at       timestamptz       NOT NULL DEFAULT now(),
    CONSTRAINT job_outbox_attempts_nonneg CHECK (attempts >= 0),
    CONSTRAINT job_outbox_max_attempts_pos CHECK (max_attempts >= 1)
);

-- One logical job per tenant+type+idempotency key (NULL key = no dedupe).
CREATE UNIQUE INDEX job_outbox_idempotency_uidx
    ON job_outbox (tenant_id, job_type, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Worker pickup: due PENDING (or expired LEASED) rows.
CREATE INDEX job_outbox_due_idx
    ON job_outbox (run_at, created_at)
    WHERE status IN ('PENDING', 'LEASED');

CREATE INDEX job_outbox_dead_letter_idx
    ON job_outbox (updated_at DESC)
    WHERE status = 'DEAD_LETTER';
