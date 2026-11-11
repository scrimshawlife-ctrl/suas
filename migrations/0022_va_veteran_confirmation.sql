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
--    An attempt is first written PENDING (unsettled) and settled after the VA call, so no
--    database lock is held across it.
-- 5. notice_version: the pre-call notice the person saw, e.g. va-notice-v1.
-- 6. idempotency_key, request_fingerprint, fingerprint_key_id: the attempt is its own
--    idempotency record. The fingerprint is an HMAC under SUAS_FINGERPRINT_KEY; the key id
--    says which key, so a rotated key is recognized.
-- 7. identity_hash, identity_key_id: HMAC of the normalized first name, last name and birth
--    date (label suas/identity/v1), kept on attempts VA answered. Never the values. A
--    settled VA VERIFIED row must carry one, so it cannot slip past the one-identity index.
-- 8. identity_released_at: when a REVOKED row or account deletion freed the identity. The
--    hash is cleared at the same time, so another account may verify it.
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
            'NETWORK_ERROR',
            'IDENTITY_CONFLICT'
        )),
    ADD COLUMN settled_at timestamptz,
    ADD COLUMN notice_version text,
    ADD COLUMN idempotency_key text,
    ADD COLUMN request_fingerprint text,
    ADD COLUMN fingerprint_key_id text,
    ADD COLUMN identity_hash text,
    ADD COLUMN identity_key_id text,
    ADD COLUMN identity_released_at timestamptz,
    ADD CONSTRAINT veteran_verifications_fingerprint_key_check
        CHECK ((request_fingerprint IS NULL) = (fingerprint_key_id IS NULL)),
    ADD CONSTRAINT veteran_verifications_identity_key_check
        CHECK ((identity_hash IS NULL) = (identity_key_id IS NULL)),
    ADD CONSTRAINT veteran_verifications_pending_unsettled_check
        CHECK (status <> 'PENDING' OR settled_at IS NULL),
    -- Older OAuth-track rows have no settled_at and never open the gate.
    ADD CONSTRAINT veteran_verifications_verified_identity_check
        CHECK (
            method <> 'VA_VETERAN_STATUS'
            OR status <> 'VERIFIED'
            OR settled_at IS NULL
            OR identity_released_at IS NOT NULL
            OR identity_hash IS NOT NULL
        );

-- The gate and the attempt limit read a person's settled confirmation rows, newest first.
CREATE INDEX veteran_verifications_settled_idx
    ON veteran_verifications (tenant_id, user_id, settled_at DESC)
    WHERE method = 'VA_VETERAN_STATUS' AND settled_at IS NOT NULL;

-- One VA attempt in flight per person: attempts are serialized without a lock held over
-- the VA call.
CREATE UNIQUE INDEX veteran_verifications_one_pending_va_key
    ON veteran_verifications (tenant_id, user_id)
    WHERE method = 'VA_VETERAN_STATUS' AND status = 'PENDING';

-- One VA-verified identity per tenant (owner review of #236, must-fix 1).
CREATE UNIQUE INDEX veteran_verifications_verified_identity_key
    ON veteran_verifications (tenant_id, identity_hash)
    WHERE method = 'VA_VETERAN_STATUS' AND status = 'VERIFIED' AND identity_hash IS NOT NULL;

-- A retried confirm finds its earlier attempt by Idempotency-Key.
CREATE INDEX veteran_verifications_idempotency_idx
    ON veteran_verifications (tenant_id, user_id, idempotency_key, created_at DESC)
    WHERE idempotency_key IS NOT NULL;

-- A revocation or an account deletion frees the person's VA-verified identity, so a wrong
-- or abandoned binding does not hold the identity for good (owner review of #73 item 4).
CREATE FUNCTION suas_release_verified_identity(p_tenant_id uuid, p_user_id uuid) RETURNS void
LANGUAGE sql AS $$
    UPDATE veteran_verifications
       SET identity_hash = NULL, identity_key_id = NULL, identity_released_at = now()
     WHERE tenant_id = p_tenant_id AND user_id = p_user_id
       AND method = 'VA_VETERAN_STATUS' AND status = 'VERIFIED'
       AND identity_released_at IS NULL;
$$;

CREATE FUNCTION suas_release_identity_on_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM suas_release_verified_identity(NEW.tenant_id, NEW.user_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER veteran_verifications_release_identity_on_revoke
    AFTER INSERT ON veteran_verifications
    FOR EACH ROW WHEN (NEW.status = 'REVOKED')
    EXECUTE FUNCTION suas_release_identity_on_revoke();

CREATE FUNCTION suas_release_identity_on_user_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM suas_release_verified_identity(NEW.tenant_id, NEW.user_id);
    RETURN NULL;
END;
$$;

CREATE TRIGGER users_release_identity_on_delete
    AFTER UPDATE OF deleted_at ON users
    FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION suas_release_identity_on_user_delete();
