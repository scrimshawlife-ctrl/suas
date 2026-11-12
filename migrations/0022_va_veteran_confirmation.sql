-- 0022_va_veteran_confirmation.sql — VA Veteran Confirmation results (suas-specs #72 R9.1, proposal)
--
-- R9.1 proposes a VA Veteran Confirmation result of VERIFIED as the gate for requesting
-- help, recorded as a `VA_VETERAN_STATUS` row. The row keeps only the method, status,
-- reason, provider environment, projection id, a bounded failure class and times
-- (D035_VA_CONFIRMATION_ADAPTER.md §9). The demographic projection itself is never stored.
--
-- 1. provider_environment: NONE (the deterministic fixture), SANDBOX or PRODUCTION. Null on
--    older rows written before this migration (the OAuth sandbox track and the ID scan).
-- 2. projection_id: the released projection the attempt sent, e.g.
--    VA_CONFIRMATION_V1_REQUIRED_ONLY. Never the projection values.
-- 3. failure_class: D035 §11 adapter failure classes, null when the provider answered.
-- 4. settled_at: when the attempt's result was recorded. The gate reads settled rows only.
--
-- The 0012/0014 checks already admit these rows: VERIFIED carries verified_at, and a
-- VA_VETERAN_STATUS NOT_CONFIRMED row always carries a VA reason.

ALTER TABLE veteran_verifications
    ADD COLUMN provider_environment text
        CONSTRAINT veteran_verifications_provider_environment_check
        CHECK (provider_environment IN ('NONE', 'SANDBOX', 'PRODUCTION')),
    ADD COLUMN projection_id text,
    ADD COLUMN failure_class text
        CONSTRAINT veteran_verifications_failure_class_check
        CHECK (failure_class IN (
            'CONFIGURATION_INVALID',
            'AUTHENTICATION_REJECTED',
            'REQUEST_INVALID',
            'PROVIDER_RATE_LIMITED',
            'PROVIDER_UNAVAILABLE',
            'PROVIDER_RESPONSE_INVALID',
            'PROVIDER_REASON_UNKNOWN',
            'TIMEOUT',
            'NETWORK_ERROR'
        )),
    ADD COLUMN settled_at timestamptz;

-- The gate and the attempt limit read a person's settled confirmation rows, newest first.
CREATE INDEX veteran_verifications_settled_idx
    ON veteran_verifications (tenant_id, user_id, settled_at DESC)
    WHERE method = 'VA_VETERAN_STATUS' AND settled_at IS NOT NULL;
