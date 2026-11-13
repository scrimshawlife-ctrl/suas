-- 0024_licence_reviews.sql — Veteran licence reviews (suas-specs #73 R10.1, proposal)
--
-- After VA answers NOT_CONFIRMED, a Veteran may send photos of a state licence and a live
-- selfie. The reader reads the licence, a SUAS Admin approves and a second, different admin
-- confirms. Only a confirmation writes a MANUAL_REVIEW VERIFIED row in veteran_verifications.
--
-- 1. va_attempt_id: the NOT_CONFIRMED VA attempt whose identity hash the licence is matched
--    against (§2.2). identity_match keeps only YES, NO or UNKNOWN, never the values.
-- 2. front_key / back_key / selfie_key, read_result: held while the review is open, then
--    cleared at the decision or an UNREADABLE settle (§2.3). Keys hold the review id only.
-- 3. licence_fingerprint + licence_fingerprint_key_id: keyed HMAC (label suas/licence/v1) of
--    the issuing state and licence number. Kept while open and on APPROVED rows only.
--    fingerprint_released_at marks an APPROVED row whose person deleted their account.
-- 4. conflicting_review_id: the APPROVED review already holding this licence when it was
--    read, found under the current and previous key, for the duplicate check and dispute
--    routing (L7.3).
-- 5. approved_by / confirmed_by / declined_by / revoked_by: SUAS Admin user ids. The by-eye
--    checklist booleans (L5.3) are stored for each of the two approving admins.
-- 6. Recusals live in veteran_licence_review_recusals; the reader's circuit breaker lives in
--    licence_reader_breaker, because Lambdas share no memory (L4.6).

CREATE TABLE veteran_licence_reviews (
    review_id uuid PRIMARY KEY,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text NOT NULL
        CONSTRAINT veteran_licence_reviews_status_check
        CHECK (status IN ('READING', 'UNREADABLE', 'AWAITING_REVIEW', 'AWAITING_CONFIRMATION',
                          'APPROVED', 'DECLINED', 'REVOKED')),
    va_attempt_id uuid NOT NULL REFERENCES veteran_verifications (verification_id),
    notice_version text NOT NULL,
    dispute_of_review_id uuid REFERENCES veteran_licence_reviews (review_id),
    front_key text,
    back_key text,
    selfie_key text,
    read_result jsonb,
    identity_match text
        CONSTRAINT veteran_licence_reviews_identity_match_check
        CHECK (identity_match IN ('YES', 'NO', 'UNKNOWN')),
    licence_fingerprint text,
    licence_fingerprint_key_id text,
    fingerprint_released_at timestamptz,
    conflicting_review_id uuid REFERENCES veteran_licence_reviews (review_id),
    failure_class text
        CONSTRAINT veteran_licence_reviews_failure_class_check
        CHECK (failure_class IN (
            'CONFIGURATION_INVALID',
            'AUTHENTICATION_REJECTED',
            'REQUEST_INVALID',
            'PROVIDER_UNAVAILABLE',
            'PROVIDER_RESPONSE_INVALID',
            'TIMEOUT',
            'NETWORK_ERROR',
            'NOT_A_LICENCE',
            'NOT_SYNTHETIC',
            'PHOTOS_GONE',
            'PHOTOS_EXPIRED'
        )),
    decline_reason text
        CONSTRAINT veteran_licence_reviews_decline_reason_check
        CHECK (decline_reason IN (
            'NO_VETERAN_DESIGNATION',
            'UNREADABLE',
            'EXPIRED',
            'IDENTITY_MISMATCH',
            'SELFIE_MISMATCH',
            'ALREADY_USED',
            'OTHER'
        )),
    revoke_reason text
        CONSTRAINT veteran_licence_reviews_revoke_reason_check
        CHECK (revoke_reason IN ('FRAUD', 'REVIEW_ERROR')),
    approved_by uuid,
    approved_at timestamptz,
    selfie_matches boolean,
    security_features_present boolean,
    whole_card boolean,
    confirmed_by uuid,
    confirmed_at timestamptz,
    confirm_selfie_matches boolean,
    confirm_security_features_present boolean,
    confirm_whole_card boolean,
    declined_by uuid,
    revoked_by uuid,
    revoked_at timestamptz,
    read_at timestamptz,
    decided_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (user_id, tenant_id) REFERENCES users (user_id, tenant_id),
    -- A decline always names its reason, and only a decline has one.
    CONSTRAINT veteran_licence_reviews_decline_reason_status_check
        CHECK ((status = 'DECLINED') = (decline_reason IS NOT NULL)),
    -- Only an UNREADABLE review carries a failure class.
    CONSTRAINT veteran_licence_reviews_failure_class_status_check
        CHECK ((status = 'UNREADABLE') = (failure_class IS NOT NULL)),
    -- Only a revoked review carries a revoke reason and its admin.
    CONSTRAINT veteran_licence_reviews_revoke_status_check
        CHECK ((status = 'REVOKED') = (revoke_reason IS NOT NULL AND revoked_by IS NOT NULL)),
    -- A settled or decided row holds no image key and no reading.
    CONSTRAINT veteran_licence_reviews_decided_cleared_check
        CHECK (
            status IN ('READING', 'AWAITING_REVIEW', 'AWAITING_CONFIRMATION')
            OR (front_key IS NULL AND back_key IS NULL AND selfie_key IS NULL
                AND read_result IS NULL)
        ),
    CONSTRAINT veteran_licence_reviews_fingerprint_key_check
        CHECK ((licence_fingerprint IS NULL) = (licence_fingerprint_key_id IS NULL)),
    -- An approval keeps its fingerprint, so one-licence-per-tenant cannot be skipped, unless
    -- the person deleted their account.
    CONSTRAINT veteran_licence_reviews_approved_fingerprint_check
        CHECK (status <> 'APPROVED' OR licence_fingerprint IS NOT NULL
               OR fingerprint_released_at IS NOT NULL),
    -- §2.3: no fingerprint outlives a decline, an unreadable read or a revoke.
    CONSTRAINT veteran_licence_reviews_closed_fingerprint_check
        CHECK (status NOT IN ('DECLINED', 'UNREADABLE', 'REVOKED')
               OR licence_fingerprint IS NULL),
    -- L5.4: a first approval names its admin and the three ticked checks.
    CONSTRAINT veteran_licence_reviews_approval_check
        CHECK (
            status NOT IN ('AWAITING_CONFIRMATION', 'APPROVED')
            OR (approved_by IS NOT NULL AND approved_at IS NOT NULL
                AND selfie_matches AND security_features_present AND whole_card)
        ),
    -- L5.5: a confirmation is a second, different admin, with their own three checks.
    CONSTRAINT veteran_licence_reviews_confirmation_check
        CHECK (
            status NOT IN ('APPROVED', 'REVOKED')
            OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL
                AND confirm_selfie_matches AND confirm_security_features_present
                AND confirm_whole_card)
        ),
    CONSTRAINT veteran_licence_reviews_two_admins_check
        CHECK (approved_by IS NULL OR confirmed_by IS NULL OR approved_by <> confirmed_by),
    CONSTRAINT veteran_licence_reviews_decided_at_check
        CHECK (status IN ('READING', 'AWAITING_REVIEW', 'AWAITING_CONFIRMATION')
               OR decided_at IS NOT NULL)
);

-- At most one open review per person (L8.5).
CREATE UNIQUE INDEX veteran_licence_reviews_one_open_key
    ON veteran_licence_reviews (tenant_id, user_id)
    WHERE status IN ('READING', 'AWAITING_REVIEW', 'AWAITING_CONFIRMATION');

-- One approved licence per tenant. A second approval of the same fingerprint fails here,
-- whatever the application checked.
CREATE UNIQUE INDEX veteran_licence_reviews_fingerprint_approved_key
    ON veteran_licence_reviews (tenant_id, licence_fingerprint)
    WHERE status = 'APPROVED' AND licence_fingerprint IS NOT NULL;

-- The person's newest review and the rolling submission limit.
CREATE INDEX veteran_licence_reviews_subject_idx
    ON veteran_licence_reviews (tenant_id, user_id, created_at DESC);

-- The admin queue, oldest first.
CREATE INDEX veteran_licence_reviews_queue_idx
    ON veteran_licence_reviews (tenant_id, status, created_at, review_id);

-- Whether a licence is on another review in the tenant.
CREATE INDEX veteran_licence_reviews_fingerprint_idx
    ON veteran_licence_reviews (tenant_id, licence_fingerprint, licence_fingerprint_key_id)
    WHERE licence_fingerprint IS NOT NULL;

-- The PHOTOS_EXPIRED sweep reads open reviews by age.
CREATE INDEX veteran_licence_reviews_open_age_idx
    ON veteran_licence_reviews (created_at)
    WHERE status IN ('READING', 'AWAITING_REVIEW', 'AWAITING_CONFIRMATION');

-- L5.6: an admin who recused is not shown the review and may not act on it.
CREATE TABLE veteran_licence_review_recusals (
    review_id uuid NOT NULL REFERENCES veteran_licence_reviews (review_id),
    admin_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (review_id, admin_id)
);

-- L4.6: one row per deployment. Opens after 5 reader-unavailable outcomes in a row; after
-- 15 minutes one probe read is let through.
CREATE TABLE licence_reader_breaker (
    breaker_id text PRIMARY KEY CHECK (breaker_id = 'licence-reader'),
    consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
    opened_at timestamptz,
    probe_started_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO licence_reader_breaker (breaker_id) VALUES ('licence-reader');

-- L7.1: a REVIEW_ERROR revoke writes a newer MANUAL_REVIEW NOT_CONFIRMED row with no VA
-- reason, so that method no longer needs one (0014 exempted only ID_SCAN_SELFIE).
ALTER TABLE veteran_verifications DROP CONSTRAINT veteran_verifications_not_confirmed_reason_check;
ALTER TABLE veteran_verifications
    ADD CONSTRAINT veteran_verifications_not_confirmed_reason_check
    CHECK (
        status <> 'NOT_CONFIRMED'
        OR not_confirmed_reason IS NOT NULL
        OR method IN ('ID_SCAN_SELFIE', 'MANUAL_REVIEW')
    );

-- L8.6 and L7.5: a REVOKED standing or an account deletion closes the person's open review
-- as DECLINED / OTHER, whoever wrote it. The images are deleted by a queued job, which also
-- writes the Audit Event, because storage is outside the database.
CREATE FUNCTION suas_close_open_licence_review(p_tenant_id uuid, p_user_id uuid, p_cause text)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    closed uuid;
BEGIN
    UPDATE veteran_licence_reviews
       SET status = 'DECLINED', decline_reason = 'OTHER', decided_at = now(),
           front_key = NULL, back_key = NULL, selfie_key = NULL, read_result = NULL,
           licence_fingerprint = NULL, licence_fingerprint_key_id = NULL, updated_at = now()
     WHERE tenant_id = p_tenant_id AND user_id = p_user_id
       AND status IN ('READING', 'AWAITING_REVIEW', 'AWAITING_CONFIRMATION')
    RETURNING review_id INTO closed;
    IF closed IS NOT NULL THEN
        INSERT INTO job_outbox (job_id, tenant_id, job_type, payload, idempotency_key)
        VALUES (gen_random_uuid(), p_tenant_id::text, 'licence.close',
                jsonb_build_object('review_id', closed, 'cause', p_cause),
                'licence.close:' || closed)
        ON CONFLICT DO NOTHING;
    END IF;
END;
$$;

CREATE FUNCTION suas_close_licence_review_on_revoke() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM suas_close_open_licence_review(NEW.tenant_id, NEW.user_id, 'REVOKED');
    RETURN NULL;
END;
$$;

CREATE TRIGGER veteran_verifications_close_licence_review_on_revoke
    AFTER INSERT ON veteran_verifications
    FOR EACH ROW WHEN (NEW.status = 'REVOKED')
    EXECUTE FUNCTION suas_close_licence_review_on_revoke();

-- Account deletion also frees every licence fingerprint the person holds.
CREATE FUNCTION suas_release_licences_on_user_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM suas_close_open_licence_review(NEW.tenant_id, NEW.user_id, 'ACCOUNT_DELETED');
    UPDATE veteran_licence_reviews
       SET licence_fingerprint = NULL, licence_fingerprint_key_id = NULL,
           fingerprint_released_at = now(), updated_at = now()
     WHERE tenant_id = NEW.tenant_id AND user_id = NEW.user_id
       AND licence_fingerprint IS NOT NULL;
    RETURN NULL;
END;
$$;

CREATE TRIGGER users_release_licences_on_delete
    AFTER UPDATE OF deleted_at ON users
    FOR EACH ROW WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
    EXECUTE FUNCTION suas_release_licences_on_user_delete();
