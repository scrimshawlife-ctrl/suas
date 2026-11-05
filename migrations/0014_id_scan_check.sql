-- 0014_id_scan_check.sql — track an ID scan + selfie check on veteran_verifications
--
-- Implements V1_PROJECT_PLAN.md §2.1 / §4.3 F2: a person starts a check through the
-- ID verification port, and the result is recorded here. Three additions to the
-- 0012 table, all for the ID_SCAN_SELFIE method:
--
-- 1. provider_check_id: the opaque id the port returned, so a later status read can
--    ask the port for the outcome. It is not an identity document, image, or score.
-- 2. NOT_CONFIRMED needs no VA reason for an ID scan. The 0012 reasons describe VA
--    answers; the port reports only a status, so requiring a reason would force an
--    invented one.
-- 3. At most one PENDING scan per person, so a double-tapped "start" opens one check.

ALTER TABLE veteran_verifications ADD COLUMN provider_check_id text;

-- Replace the NOT_CONFIRMED-needs-a-reason check (its generated name is not fixed
-- by 0012, so find it by definition).
DO $$
DECLARE
    old_check text;
BEGIN
    FOR old_check IN
        SELECT conname FROM pg_constraint
        WHERE conrelid = 'veteran_verifications'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%NOT_CONFIRMED%'
    LOOP
        EXECUTE format('ALTER TABLE veteran_verifications DROP CONSTRAINT %I', old_check);
    END LOOP;
END $$;

ALTER TABLE veteran_verifications
    ADD CONSTRAINT veteran_verifications_not_confirmed_reason_check
    CHECK (
        status <> 'NOT_CONFIRMED'
        OR not_confirmed_reason IS NOT NULL
        OR method = 'ID_SCAN_SELFIE'
    );

CREATE UNIQUE INDEX veteran_verifications_one_pending_scan_key
    ON veteran_verifications (tenant_id, user_id)
    WHERE method = 'ID_SCAN_SELFIE' AND status = 'PENDING';
